// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectResumeFormat,
  DocumentConversionError,
  prepareResumePdf,
} from './prepare-resume-pdf';
import {
  jpegWithDimensions,
  pngWithDimensions,
  SYNTHETIC_JPEG,
  SYNTHETIC_PNG,
} from './image-test-fixtures';

function classicPdf(version = '1.7', trailingWhitespace = '\n'): Buffer {
  const body = Buffer.from(
    `%PDF-${version}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n`,
    'ascii',
  );
  const xref = Buffer.from(
    'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n' +
      'trailer\n<< /Size 2 /Root 1 0 R >>\n',
    'ascii',
  );
  return Buffer.concat([
    body,
    xref,
    Buffer.from(`startxref\n${body.length}\n%%EOF${trailingWhitespace}`, 'ascii'),
  ]);
}

function xrefStreamPdf(): Buffer {
  const header = Buffer.from('%PDF-1.7\n', 'ascii');
  const xrefObject = Buffer.from(
    '5 0 obj\n<< /Length 1 /Type/XRef /Size 6 >>\nstream\n0\nendstream\nendobj\n',
    'ascii',
  );
  return Buffer.concat([
    header,
    xrefObject,
    Buffer.from(`startxref\n${header.length}\n%%EOF\n`, 'ascii'),
  ]);
}

function nestedXrefTypeSpoof(): Buffer {
  const header = Buffer.from('%PDF-1.7\n', 'ascii');
  const ordinaryStream = Buffer.from(
    '5 0 obj\n<< /Length 1 /DecodeParms << /Type /XRef >> >>\n' +
      'stream\n0\nendstream\nendobj\n',
    'ascii',
  );
  return Buffer.concat([
    header,
    ordinaryStream,
    Buffer.from(`startxref\n${header.length}\n%%EOF\n`, 'ascii'),
  ]);
}

function incrementalPdf(): Buffer {
  const original = classicPdf();
  const update = Buffer.from('2 0 obj\n<< /Producer (incremental) >>\nendobj\n', 'ascii');
  const xrefOffset = original.length + update.length;
  return Buffer.concat([
    original,
    update,
    Buffer.from(
      'xref\n2 1\n0000000000 00000 n \n' +
        `trailer\n<< /Size 3 /Prev 45 >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'ascii',
    ),
  ]);
}

function findDocxCentralEntry(buffer: Buffer, entryName: string): {
  centralNameOffset: number;
  localNameOffset: number;
} {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('test fixture has no EOCD');
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = buffer.readUInt16LE(eocd + 10);
  for (let index = 0; index < entries; index += 1) {
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const centralNameOffset = cursor + 46;
    const name = buffer.subarray(centralNameOffset, centralNameOffset + nameBytes).toString('utf8');
    if (name === entryName) {
      const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
      return { centralNameOffset, localNameOffset: localHeaderOffset + 30 };
    }
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  throw new Error(`test fixture has no ${entryName} entry`);
}

function renamedDocxEntry(buffer: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error('test ZIP entry replacement must preserve byte length');
  }
  const copy = Buffer.from(buffer);
  const offsets = findDocxCentralEntry(copy, from);
  copy.write(to, offsets.centralNameOffset, 'utf8');
  copy.write(to, offsets.localNameOffset, 'utf8');
  return copy;
}

const PDF = classicPdf();
const FIXTURE_DIR = join(process.cwd(), 'lib', 'resume-convert', 'fixtures');
const DOCX = readFileSync(join(FIXTURE_DIR, 'synthetic-resume.docx'));
const DOC = readFileSync(join(FIXTURE_DIR, 'synthetic-resume.doc'));

function pdfResponse(body: Buffer = PDF): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'gotenberg-trace': 'gt-test' },
  });
}

beforeEach(() => {
  delete process.env.DOCUMENT_CONVERTER_URL;
  delete process.env.DOCUMENT_CONVERTER_TIMEOUT_MS;
  delete process.env.DOCUMENT_CONVERTER_MAX_INPUT_BYTES;
  delete process.env.DOCUMENT_CONVERTER_MAX_OUTPUT_BYTES;
  vi.restoreAllMocks();
});

describe('detectResumeFormat', () => {
  it('recognises only validated PDF, Word, JPEG and PNG structures', () => {
    expect(detectResumeFormat(PDF)).toBe('pdf');
    expect(detectResumeFormat(DOCX)).toBe('docx');
    expect(detectResumeFormat(DOC)).toBe('doc');
    expect(detectResumeFormat(SYNTHETIC_JPEG)).toBe('jpeg');
    expect(detectResumeFormat(SYNTHETIC_PNG)).toBe('png');
  });

  it('recognises the committed real Word 97 and OOXML fixtures', () => {
    expect(detectResumeFormat(DOC)).toBe('doc');
    expect(detectResumeFormat(DOCX)).toBe('docx');
  });

  it('accepts an exact DOCX EOCD comment while keeping the real data descriptors valid', () => {
    const withComment = Buffer.concat([DOCX, Buffer.from('fixture-comment', 'ascii')]);
    withComment.writeUInt16LE(Buffer.byteLength('fixture-comment'), DOCX.length - 2);
    expect(detectResumeFormat(withComment)).toBe('docx');
  });

  it('does not accept marker-spoofed ZIP/OLE bytes or a truncated PDF', () => {
    expect(detectResumeFormat(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('[Content_Types].xml\0word/document.xml'),
    ]))).toBe('unknown');
    expect(detectResumeFormat(Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('WordDocument', 'utf16le'),
    ]))).toBe('unknown');
    expect(detectResumeFormat(Buffer.from('%PDF-1.7'))).toBe('unknown');
  });

  it('accepts supported PDF versions with classic, stream and incremental xrefs', () => {
    expect(detectResumeFormat(classicPdf('1.0'))).toBe('pdf');
    expect(detectResumeFormat(classicPdf('1.7', '\0\t\r\n\f '))).toBe('pdf');
    expect(detectResumeFormat(classicPdf('2.0'))).toBe('pdf');
    expect(detectResumeFormat(xrefStreamPdf())).toBe('pdf');
    expect(detectResumeFormat(incrementalPdf())).toBe('pdf');
  });

  it('rejects spoofed PDF markers, unsupported versions and bytes after final EOF', () => {
    const markerSpoof = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n',
      'ascii',
    );
    expect(detectResumeFormat(markerSpoof)).toBe('unknown');
    expect(detectResumeFormat(classicPdf('1.8'))).toBe('unknown');
    expect(detectResumeFormat(classicPdf('1.9'))).toBe('unknown');
    expect(detectResumeFormat(Buffer.concat([PDF, Buffer.from('not-whitespace')]))).toBe('unknown');
    expect(detectResumeFormat(nestedXrefTypeSpoof())).toBe('unknown');
  });

  it('rejects DOCX packages with trailing data, missing package rels or local-name mismatch', () => {
    expect(detectResumeFormat(Buffer.concat([DOCX, Buffer.from('trailing-junk')]))).toBe('unknown');
    expect(detectResumeFormat(renamedDocxEntry(DOCX, '_rels/.rels', '_rels/xrels')))
      .toBe('unknown');

    const mismatchedLocalName = Buffer.from(DOCX);
    const { localNameOffset } = findDocxCentralEntry(mismatchedLocalName, 'word/document.xml');
    mismatchedLocalName[localNameOffset + Buffer.byteLength('word/document.xm')] = 0x6b;
    expect(detectResumeFormat(mismatchedLocalName)).toBe('unknown');
  });

  it('rejects DOCX entries using a converter-unapproved compression method', () => {
    const unsupportedCompression = Buffer.from(DOCX);
    const { centralNameOffset } = findDocxCentralEntry(unsupportedCompression, 'word/document.xml');
    unsupportedCompression.writeUInt16LE(99, centralNameOffset - 36);
    expect(detectResumeFormat(unsupportedCompression)).toBe('unknown');
  });

  it('rejects marker-only, truncated and CRC-corrupted images', () => {
    const corruptPng = Buffer.from(SYNTHETIC_PNG);
    corruptPng[41] ^= 0x01;

    expect(detectResumeFormat(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe('unknown');
    expect(detectResumeFormat(SYNTHETIC_JPEG.subarray(0, -2))).toBe('unknown');
    expect(detectResumeFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toBe('unknown');
    expect(detectResumeFormat(SYNTHETIC_PNG.subarray(0, -4))).toBe('unknown');
    expect(detectResumeFormat(corruptPng)).toBe('unknown');
  });

  it('rejects images over the per-side or total-pixel safety ceilings', () => {
    expect(detectResumeFormat(pngWithDimensions(32_769, 1))).toBe('unknown');
    expect(detectResumeFormat(jpegWithDimensions(32_769, 1))).toBe('unknown');
    expect(detectResumeFormat(pngWithDimensions(8_000, 6_000))).toBe('unknown');
    expect(detectResumeFormat(jpegWithDimensions(8_000, 6_000))).toBe('unknown');
  });
});

describe('prepareResumePdf', () => {
  it('passes a verified PDF through as the same Buffer without calling Gotenberg', async () => {
    const fetchImpl = vi.fn();
    const result = await prepareResumePdf(PDF, '../候选人\r\n.pdf', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.pdf).toBe(PDF);
    expect(result).toMatchObject({
      filename: '候选人__.pdf',
      sourceFormat: 'pdf',
      converted: false,
      originalBytes: PDF.length,
      pdfBytes: PDF.length,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['doc', DOC, 'application/msword', 'doc'],
    ['jpeg', SYNTHETIC_JPEG, 'image/jpeg', 'jpg'],
    ['png', SYNTHETIC_PNG, 'image/png', 'png'],
  ] as const)('converts %s through the Gotenberg LibreOffice endpoint', async (
    format,
    input,
    mime,
    extension,
  ) => {
    const fetchImpl = vi.fn().mockResolvedValue(pdfResponse());
    const result = await prepareResumePdf(input, `张三.${extension}`, {
      converterUrl: 'http://gotenberg:3000',
      traceId: 'trace-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      filename: '张三.pdf',
      sourceFormat: format,
      converted: true,
      originalBytes: input.length,
      pdfBytes: PDF.length,
    });
    expect(result.pdf).toEqual(PDF);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://gotenberg:3000/forms/libreoffice/convert');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ 'Gotenberg-Trace': 'trace-123' });
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    const file = form.get('files') as File;
    expect(file.name).toBe(`resume.${format}`);
    expect(file.type).toBe(mime);
    expect(file.name).not.toContain('张三');
    expect(form.get('exportFormFields')).toBe('false');
  });

  it('selects the converter format from validated bytes, not a spoofed filename extension', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pdfResponse());
    const result = await prepareResumePdf(SYNTHETIC_PNG, 'renamed-as-pdf.pdf', {
      converterUrl: 'http://gotenberg:3000',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.sourceFormat).toBe('png');
    expect(result.converted).toBe(true);
    const form = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
    const file = form.get('files') as File;
    expect(file.name).toBe('resume.png');
    expect(file.type).toBe('image/png');
  });

  it('rejects unsupported and empty documents before any network request', async () => {
    const fetchImpl = vi.fn();
    await expect(prepareResumePdf(Buffer.from('<html>not an image</html>'), 'resume.png', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      category: 'document',
      retryable: false,
    });
    await expect(prepareResumePdf(Buffer.alloc(0), 'resume.docx', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'EMPTY_DOCUMENT', category: 'document' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the converter URL is absent or malformed', async () => {
    await expect(prepareResumePdf(DOCX, 'resume.docx')).rejects.toMatchObject({
      code: 'CONVERTER_NOT_CONFIGURED',
      category: 'configuration',
    });
    await expect(prepareResumePdf(DOCX, 'resume.docx', {
      converterUrl: 'http://gotenberg:3000/not-an-origin',
    })).rejects.toMatchObject({
      code: 'CONVERTER_INVALID_CONFIG',
      category: 'configuration',
    });
  });

  it('does not blame candidate data for ambiguous converter 4xx responses', async () => {
    const privateConverterError = 'invalid document: 张三候选人 / 19999990001';
    const rejectedFetch = vi.fn().mockResolvedValue(
      new Response(privateConverterError, { status: 400 }),
    );
    const rejectedError = await prepareResumePdf(DOCX, 'resume.docx', {
      converterUrl: 'http://gotenberg:3000',
      fetchImpl: rejectedFetch as unknown as typeof fetch,
    }).catch((caught) => caught);
    expect(rejectedError).toMatchObject({
      code: 'CONVERTER_REJECTED',
      category: 'configuration',
      retryable: false,
      httpStatus: 400,
      message: 'document converter returned HTTP 400',
    });
    expect(String(rejectedError)).not.toContain(privateConverterError);

    const unavailableFetch = vi.fn().mockResolvedValue(
      new Response('service unavailable', { status: 503 }),
    );
    await expect(prepareResumePdf(DOCX, 'resume.docx', {
      converterUrl: 'http://gotenberg:3000',
      fetchImpl: unavailableFetch as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'CONVERTER_UNAVAILABLE',
      category: 'dependency',
      retryable: true,
      httpStatus: 503,
    });

    const throttledFetch = vi.fn().mockResolvedValue(
      new Response('too many conversions', { status: 429 }),
    );
    await expect(prepareResumePdf(DOCX, 'resume.docx', {
      converterUrl: 'http://gotenberg:3000',
      fetchImpl: throttledFetch as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'CONVERTER_UNAVAILABLE',
      category: 'dependency',
      retryable: true,
      httpStatus: 429,
    });
  });

  it('classifies timeout/network failures as retryable dependency errors', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    await expect(prepareResumePdf(DOC, 'resume.doc', {
      converterUrl: 'http://gotenberg:3000',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'CONVERTER_TIMEOUT',
      category: 'dependency',
      retryable: true,
    });
  });

  it('rejects a successful response that is not a verified PDF', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<html>not pdf</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(prepareResumePdf(DOCX, 'resume.docx', {
      converterUrl: 'http://gotenberg:3000',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'CONVERTER_INVALID_RESPONSE',
      category: 'dependency',
    });
  });

  it('enforces input and output byte limits', async () => {
    await expect(prepareResumePdf(PDF, 'resume.pdf', {
      maxInputBytes: PDF.length - 1,
    })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
      category: 'document',
      sourceFormat: 'unknown',
    });

    const fetchImpl = vi.fn().mockResolvedValue(pdfResponse());
    await expect(prepareResumePdf(DOCX, 'resume.docx', {
      converterUrl: 'http://gotenberg:3000',
      maxOutputBytes: PDF.length - 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE', category: 'document' });
  });

  it('exposes a stable typed error class for callers', async () => {
    try {
      await prepareResumePdf(Buffer.from('bad'), 'bad.bin');
      throw new Error('expected conversion error');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentConversionError);
    }
  });
});

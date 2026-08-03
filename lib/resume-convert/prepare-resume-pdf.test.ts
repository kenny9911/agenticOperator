// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectResumeFormat,
  DocumentConversionError,
  prepareResumePdf,
} from './prepare-resume-pdf';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n');
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
  it('recognises only validated PDF, OOXML Word and OLE Word containers', () => {
    expect(detectResumeFormat(PDF)).toBe('pdf');
    expect(detectResumeFormat(DOCX)).toBe('docx');
    expect(detectResumeFormat(DOC)).toBe('doc');
  });

  it('recognises the committed real Word 97 and OOXML fixtures', () => {
    expect(detectResumeFormat(DOC)).toBe('doc');
    expect(detectResumeFormat(DOCX)).toBe('docx');
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
    ['docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['doc', DOC, 'application/msword'],
  ] as const)('converts %s through the Gotenberg LibreOffice endpoint', async (format, input, mime) => {
    const fetchImpl = vi.fn().mockResolvedValue(pdfResponse());
    const result = await prepareResumePdf(input, `张三.${format}`, {
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
    expect(form.get('exportFormFields')).toBe('false');
  });

  it('rejects unsupported and empty documents before any network request', async () => {
    const fetchImpl = vi.fn();
    await expect(prepareResumePdf(Buffer.from('plain text'), 'resume.txt', {
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
    const rejectedFetch = vi.fn().mockResolvedValue(
      new Response('invalid document', { status: 400 }),
    );
    await expect(prepareResumePdf(DOCX, 'resume.docx', {
      converterUrl: 'http://gotenberg:3000',
      fetchImpl: rejectedFetch as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'CONVERTER_REJECTED',
      category: 'configuration',
      retryable: false,
      httpStatus: 400,
    });

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

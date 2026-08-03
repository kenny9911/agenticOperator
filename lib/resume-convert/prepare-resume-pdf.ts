// Single resume-document boundary before RoboHire.
//
// RoboHire's parse endpoint accepts PDF bytes only. PDF inputs pass through
// unchanged after validation; legacy .doc and .docx inputs are converted by an
// internal Gotenberg/LibreOffice service. Every failure is fail-closed: callers
// never receive the original Office bytes disguised as application/pdf.

import type { AgentLogger } from '@/lib/agent-logger';

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const PDF_EOF = Buffer.from('%%EOF', 'ascii');
const PDF_STARTXREF = Buffer.from('startxref', 'ascii');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_DOCX_ENTRIES = 2_048;
const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 100;

const CFB_FREE_SECTOR = 0xffffffff;
const CFB_END_OF_CHAIN = 0xfffffffe;
const CFB_FAT_SECTOR = 0xfffffffd;
const CFB_DIFAT_SECTOR = 0xfffffffc;

const DEFAULT_TIMEOUT_MS = 130_000;
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;

export type ResumeFormat = 'pdf' | 'docx' | 'doc' | 'unknown';
export type DocumentConversionErrorCategory = 'document' | 'configuration' | 'dependency';
export type DocumentConversionErrorCode =
  | 'EMPTY_DOCUMENT'
  | 'UNSUPPORTED_FORMAT'
  | 'INPUT_TOO_LARGE'
  | 'OUTPUT_TOO_LARGE'
  | 'CONVERTER_NOT_CONFIGURED'
  | 'CONVERTER_INVALID_CONFIG'
  | 'CONVERTER_REJECTED'
  | 'CONVERTER_UNAVAILABLE'
  | 'CONVERTER_TIMEOUT'
  | 'CONVERTER_NETWORK'
  | 'CONVERTER_INVALID_RESPONSE';

export class DocumentConversionError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: DocumentConversionErrorCode,
    public readonly category: DocumentConversionErrorCategory,
    message: string,
    public readonly sourceFormat: ResumeFormat,
    public readonly httpStatus?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DocumentConversionError';
    this.retryable = category === 'dependency';
  }
}

export type PreparedResumePdf = {
  /** Same Buffer object for PDF input; converted PDF bytes for DOC/DOCX. */
  pdf: Buffer;
  filename: string;
  sourceFormat: Exclude<ResumeFormat, 'unknown'>;
  converted: boolean;
  originalBytes: number;
  pdfBytes: number;
};

export type PrepareResumePdfOptions = {
  converterUrl?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  traceId?: string;
  logger?: AgentLogger | null;
  fetchImpl?: typeof fetch;
};

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

export function isPdfBuffer(buffer: Buffer): boolean {
  if (!startsWith(buffer, PDF_MAGIC) || buffer.length < 16) return false;
  const version = buffer.subarray(PDF_MAGIC.length, PDF_MAGIC.length + 3).toString('ascii');
  if (!/^1\.[0-9]$/.test(version) && !/^2\.0$/.test(version)) return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 1_024));
  return tail.includes(PDF_STARTXREF) && tail.includes(PDF_EOF);
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  const minRecordBytes = 22;
  if (buffer.length < minRecordBytes) return -1;
  const firstCandidate = Math.max(0, buffer.length - minRecordBytes - 0xffff);
  for (let offset = buffer.length - minRecordBytes; offset >= firstCandidate; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/** Parse only ZIP metadata; never inflate attacker-controlled DOCX entries. */
function isSafeDocxContainer(buffer: Buffer): boolean {
  if (!startsWith(buffer, ZIP_MAGIC)) return false;
  const eocd = findZipEndOfCentralDirectory(buffer);
  if (eocd < 0) return false;

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount > MAX_DOCX_ENTRIES ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize > eocd
  ) {
    return false;
  }

  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasWordDocument = false;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY) {
      return false;
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const recordBytes = 46 + nameBytes + extraBytes + commentBytes;
    if (
      (flags & 0x1) !== 0 ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      cursor + recordBytes > buffer.length ||
      cursor + recordBytes > centralOffset + centralSize
    ) {
      return false;
    }

    const name = buffer.subarray(cursor + 46, cursor + 46 + nameBytes).toString('utf8');
    if (
      !name ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').includes('..')
    ) {
      return false;
    }
    if (name === '[Content_Types].xml') hasContentTypes = true;
    if (name === 'word/document.xml') hasWordDocument = true;

    if (
      compressedBytes > 0 &&
      uncompressedBytes / compressedBytes > MAX_DOCX_COMPRESSION_RATIO
    ) {
      return false;
    }
    if (compressedBytes === 0 && uncompressedBytes > 0) return false;
    totalCompressed += compressedBytes;
    totalUncompressed += uncompressedBytes;
    if (
      !Number.isSafeInteger(totalCompressed) ||
      !Number.isSafeInteger(totalUncompressed) ||
      totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES
    ) {
      return false;
    }
    cursor += recordBytes;
  }

  return (
    cursor === centralOffset + centralSize &&
    totalCompressed <= buffer.length &&
    hasContentTypes &&
    hasWordDocument
  );
}

function isRegularCfbSector(id: number, sectorCount: number): boolean {
  return id >= 0 && id < sectorCount && id < CFB_DIFAT_SECTOR;
}

/**
 * Validate the Compound File Binary directory and require a real WordDocument
 * stream entry. This prevents an arbitrary OLE/spoofed byte string from being
 * treated as legacy Word without loading or executing document content.
 */
function isSafeLegacyDocContainer(buffer: Buffer): boolean {
  if (!startsWith(buffer, OLE_MAGIC) || buffer.length < 512) return false;
  const majorVersion = buffer.readUInt16LE(26);
  const byteOrder = buffer.readUInt16LE(28);
  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);
  if (
    byteOrder !== 0xfffe ||
    miniSectorShift !== 6 ||
    !((majorVersion === 3 && sectorShift === 9) || (majorVersion === 4 && sectorShift === 12))
  ) {
    return false;
  }

  const sectorSize = 2 ** sectorShift;
  if (buffer.length < sectorSize || buffer.length % sectorSize !== 0) return false;
  const sectorCount = buffer.length / sectorSize - 1;
  const fatSectorCount = buffer.readUInt32LE(44);
  const firstDirectorySector = buffer.readUInt32LE(48);
  const firstDifatSector = buffer.readUInt32LE(68);
  const difatSectorCount = buffer.readUInt32LE(72);
  if (
    sectorCount <= 0 ||
    fatSectorCount === 0 ||
    fatSectorCount > sectorCount ||
    difatSectorCount > sectorCount ||
    !isRegularCfbSector(firstDirectorySector, sectorCount)
  ) {
    return false;
  }

  const sectorOffset = (id: number): number => (id + 1) * sectorSize;
  const fatSectorIds: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const id = buffer.readUInt32LE(76 + index * 4);
    if (id !== CFB_FREE_SECTOR) fatSectorIds.push(id);
  }

  let difatSector = firstDifatSector;
  const seenDifat = new Set<number>();
  for (let index = 0; index < difatSectorCount; index += 1) {
    if (!isRegularCfbSector(difatSector, sectorCount) || seenDifat.has(difatSector)) return false;
    seenDifat.add(difatSector);
    const offset = sectorOffset(difatSector);
    const idsPerSector = sectorSize / 4 - 1;
    for (let entry = 0; entry < idsPerSector; entry += 1) {
      const id = buffer.readUInt32LE(offset + entry * 4);
      if (id !== CFB_FREE_SECTOR) fatSectorIds.push(id);
    }
    difatSector = buffer.readUInt32LE(offset + idsPerSector * 4);
  }
  if (difatSectorCount === 0 && firstDifatSector !== CFB_END_OF_CHAIN) return false;
  if (fatSectorIds.length < fatSectorCount) return false;

  const fat: number[] = [];
  for (const id of fatSectorIds.slice(0, fatSectorCount)) {
    if (!isRegularCfbSector(id, sectorCount)) return false;
    const offset = sectorOffset(id);
    for (let entry = 0; entry < sectorSize / 4; entry += 1) {
      fat.push(buffer.readUInt32LE(offset + entry * 4));
    }
  }

  let directorySector = firstDirectorySector;
  const seenDirectory = new Set<number>();
  while (directorySector !== CFB_END_OF_CHAIN) {
    if (
      !isRegularCfbSector(directorySector, sectorCount) ||
      directorySector >= fat.length ||
      seenDirectory.has(directorySector)
    ) {
      return false;
    }
    seenDirectory.add(directorySector);
    const offset = sectorOffset(directorySector);
    for (let entry = 0; entry < sectorSize; entry += 128) {
      const directoryOffset = offset + entry;
      const nameLength = buffer.readUInt16LE(directoryOffset + 64);
      const objectType = buffer[directoryOffset + 66];
      if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) continue;
      const name = buffer
        .subarray(directoryOffset, directoryOffset + nameLength - 2)
        .toString('utf16le');
      if (objectType === 2 && name === 'WordDocument') {
        const streamSize = buffer.readBigUInt64LE(directoryOffset + 120);
        return streamSize > 0n;
      }
    }
    directorySector = fat[directorySector];
    if (
      directorySector === CFB_FREE_SECTOR ||
      directorySector === CFB_FAT_SECTOR ||
      directorySector === CFB_DIFAT_SECTOR
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Detect only the resume formats we explicitly support.
 *
 * DOCX is accepted only after its central directory is bounded and contains
 * the Word OOXML entries. Legacy DOC is accepted only after traversing the CFB
 * FAT/directory and finding a real WordDocument stream. No document payload is
 * inflated or executed during detection.
 */
export function detectResumeFormat(buffer: Buffer): ResumeFormat {
  if (isPdfBuffer(buffer)) return 'pdf';

  if (startsWith(buffer, ZIP_MAGIC)) return isSafeDocxContainer(buffer) ? 'docx' : 'unknown';
  if (startsWith(buffer, OLE_MAGIC)) return isSafeLegacyDocContainer(buffer) ? 'doc' : 'unknown';

  return 'unknown';
}

function readPositiveInteger(
  explicit: number | undefined,
  envName: string,
  fallback: number,
  sourceFormat: ResumeFormat,
): number {
  const raw = explicit ?? (process.env[envName] ? Number(process.env[envName]) : fallback);
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new DocumentConversionError(
      'CONVERTER_INVALID_CONFIG',
      'configuration',
      `${envName} must be a positive integer`,
      sourceFormat,
    );
  }
  return raw;
}

function parseConverterUrl(value: string | undefined, sourceFormat: ResumeFormat): URL {
  const raw = value?.trim();
  if (!raw) {
    throw new DocumentConversionError(
      'CONVERTER_NOT_CONFIGURED',
      'configuration',
      'DOCUMENT_CONVERTER_URL is required for DOC/DOCX resume conversion',
      sourceFormat,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new DocumentConversionError(
      'CONVERTER_INVALID_CONFIG',
      'configuration',
      'DOCUMENT_CONVERTER_URL must be a valid HTTP(S) origin',
      sourceFormat,
      undefined,
      cause,
    );
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new DocumentConversionError(
      'CONVERTER_INVALID_CONFIG',
      'configuration',
      'DOCUMENT_CONVERTER_URL must be an HTTP(S) origin without path, query, credentials or fragment',
      sourceFormat,
    );
  }
  return url;
}

function outputFilename(filename: string): string {
  const leaf = (filename || 'resume').split(/[\\/]/).pop() ?? 'resume';
  const withoutControl = leaf.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
  const stem = withoutControl.replace(/\.(?:pdf|docx?|docm)$/i, '').trim() || 'resume';
  return `${stem.slice(0, 120)}.pdf`;
}

function mimeFor(format: 'doc' | 'docx'): string {
  return format === 'doc'
    ? 'application/msword'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

async function readBodyWithLimit(
  response: Response,
  limit: number,
  sourceFormat: ResumeFormat,
  errorCode: DocumentConversionErrorCode,
  category: DocumentConversionErrorCategory,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new DocumentConversionError(
      errorCode,
      category,
      `document converter response exceeds ${limit} bytes`,
      sourceFormat,
      response.status,
    );
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new DocumentConversionError(
          errorCode,
          category,
          `document converter response exceeds ${limit} bytes`,
          sourceFormat,
          response.status,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function safeErrorDetail(body: Buffer): string {
  return body
    .toString('utf8')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 300);
}

async function convertOfficeWithGotenberg(
  input: Buffer,
  format: 'doc' | 'docx',
  options: PrepareResumePdfOptions,
  maxOutputBytes: number,
): Promise<Buffer> {
  const baseUrl = parseConverterUrl(
    options.converterUrl ?? process.env.DOCUMENT_CONVERTER_URL,
    format,
  );
  const timeoutMs = readPositiveInteger(
    options.timeoutMs,
    'DOCUMENT_CONVERTER_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
    format,
  );
  const endpoint = new URL('/forms/libreoffice/convert', baseUrl).toString();
  const form = new FormData();
  // A generic filename avoids putting candidate PII into converter access logs.
  form.append(
    'files',
    new Blob([new Uint8Array(input)], { type: mimeFor(format) }),
    `resume.${format}`,
  );
  form.append('exportFormFields', 'false');

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(endpoint, {
      method: 'POST',
      headers: options.traceId ? { 'Gotenberg-Trace': options.traceId } : undefined,
      body: form,
      // Never replay candidate bytes to a redirected origin. The configured
      // private service must answer this exact endpoint itself.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const errorName = cause instanceof Error ? cause.name : '';
    const timedOut = errorName === 'TimeoutError' || errorName === 'AbortError';
    options.logger?.apiCall('Gotenberg.convert', {
      url: endpoint,
      method: 'POST',
      request: { source_format: format, input_bytes: input.length },
      durationMs: Date.now() - startedAt,
      error: timedOut ? `timeout after ${timeoutMs}ms` : 'network error',
    });
    throw new DocumentConversionError(
      timedOut ? 'CONVERTER_TIMEOUT' : 'CONVERTER_NETWORK',
      'dependency',
      timedOut
        ? `document converter timed out after ${timeoutMs}ms`
        : 'document converter network request failed',
      format,
      undefined,
      cause,
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = safeErrorDetail(
        await readBodyWithLimit(
          response,
          MAX_ERROR_BODY_BYTES,
          format,
          'CONVERTER_INVALID_RESPONSE',
          'dependency',
        ),
      );
    } catch {
      // Status and trace are sufficient; never let an oversized error body hide them.
    }
    // Gotenberg uses 4xx both for bad documents and for multipart/route option
    // contract errors. A status alone cannot prove candidate data is corrupt;
    // classify ordinary remote 4xx as configuration so callers never
    // permanently fail an upload because our request shape or converter
    // version regressed. Timeout/early/rate-limit statuses remain retryable.
    const isTransientStatus =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    const isRequestRejection =
      response.status >= 400 && response.status < 500 && !isTransientStatus;
    options.logger?.apiCall('Gotenberg.convert', {
      url: endpoint,
      method: 'POST',
      request: { source_format: format, input_bytes: input.length },
      response: { status: response.status, trace: response.headers.get('gotenberg-trace') },
      status: response.status,
      durationMs: Date.now() - startedAt,
      error: detail || `HTTP ${response.status}`,
    });
    throw new DocumentConversionError(
      isRequestRejection ? 'CONVERTER_REJECTED' : 'CONVERTER_UNAVAILABLE',
      isRequestRejection ? 'configuration' : 'dependency',
      `document converter returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      format,
      response.status,
    );
  }

  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (contentType && !contentType.startsWith('application/pdf')) {
    throw new DocumentConversionError(
      'CONVERTER_INVALID_RESPONSE',
      'dependency',
      `document converter returned unexpected content-type ${contentType}`,
      format,
      response.status,
    );
  }

  const pdf = await readBodyWithLimit(
    response,
    maxOutputBytes,
    format,
    'OUTPUT_TOO_LARGE',
    'document',
  );
  if (!isPdfBuffer(pdf)) {
    throw new DocumentConversionError(
      'CONVERTER_INVALID_RESPONSE',
      'dependency',
      'document converter returned a non-PDF or empty body',
      format,
      response.status,
    );
  }

  options.logger?.apiCall('Gotenberg.convert', {
    url: endpoint,
    method: 'POST',
    request: { source_format: format, input_bytes: input.length },
    response: {
      status: response.status,
      output_bytes: pdf.length,
      trace: response.headers.get('gotenberg-trace'),
    },
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return pdf;
}

export async function prepareResumePdf(
  input: Buffer,
  filename: string,
  options: PrepareResumePdfOptions = {},
): Promise<PreparedResumePdf> {
  if (input.length === 0) {
    throw new DocumentConversionError(
      'EMPTY_DOCUMENT',
      'document',
      'resume document is empty',
      'unknown',
    );
  }

  const maxInputBytes = readPositiveInteger(
    options.maxInputBytes,
    'DOCUMENT_CONVERTER_MAX_INPUT_BYTES',
    DEFAULT_MAX_INPUT_BYTES,
    'unknown',
  );
  if (input.length > maxInputBytes) {
    throw new DocumentConversionError(
      'INPUT_TOO_LARGE',
      'document',
      `resume document exceeds ${maxInputBytes} bytes`,
      'unknown',
    );
  }

  // Enforce the byte ceiling before parsing attacker-controlled ZIP/CFB
  // metadata. Format detection may traverse bounded directory structures and
  // must never amplify work for a document that is already too large.
  const format = detectResumeFormat(input);
  const maxOutputBytes = readPositiveInteger(
    options.maxOutputBytes,
    'DOCUMENT_CONVERTER_MAX_OUTPUT_BYTES',
    DEFAULT_MAX_OUTPUT_BYTES,
    format,
  );

  if (format === 'unknown') {
    throw new DocumentConversionError(
      'UNSUPPORTED_FORMAT',
      'document',
      'resume document is not a supported PDF, DOCX or DOC file',
      format,
    );
  }

  if (format === 'pdf') {
    if (input.length > maxOutputBytes) {
      throw new DocumentConversionError(
        'OUTPUT_TOO_LARGE',
        'document',
        `resume PDF exceeds ${maxOutputBytes} bytes`,
        format,
      );
    }
    return {
      pdf: input,
      filename: outputFilename(filename),
      sourceFormat: format,
      converted: false,
      originalBytes: input.length,
      pdfBytes: input.length,
    };
  }

  const pdf = await convertOfficeWithGotenberg(input, format, options, maxOutputBytes);
  return {
    pdf,
    filename: outputFilename(filename),
    sourceFormat: format,
    converted: true,
    originalBytes: input.length,
    pdfBytes: pdf.length,
  };
}

// Single resume-document boundary before RoboHire.
//
// RoboHire's parse endpoint accepts PDF bytes only. PDF inputs pass through
// unchanged after validation; legacy .doc/.docx and supported image inputs are
// converted by an internal Gotenberg/LibreOffice service. Every failure is
// fail-closed: callers never receive source bytes disguised as application/pdf.

import type { AgentLogger } from '@/lib/agent-logger';

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const PDF_EOF = Buffer.from('%%EOF', 'ascii');
const PDF_STARTXREF = Buffer.from('startxref', 'ascii');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_DOCX_ENTRIES = 10_000;
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
const MAX_IMAGE_DIMENSION = 32_768;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_PNG_CHUNKS = 4_096;
const MAX_JPEG_SEGMENTS = 4_096;
const MAX_JPEG_SCANS = 256;

export type ResumeFormat = 'pdf' | 'docx' | 'doc' | 'jpeg' | 'png' | 'unknown';
type ConvertibleResumeFormat = Exclude<ResumeFormat, 'pdf' | 'unknown'>;
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
  /** Same Buffer object for PDF input; converted PDF bytes for other formats. */
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

const CRC32_TABLE = new Uint32Array(256);
for (let byte = 0; byte < CRC32_TABLE.length; byte += 1) {
  let crc = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  CRC32_TABLE[byte] = crc >>> 0;
}

function crc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hasSafeImageDimensions(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width <= Math.floor(MAX_IMAGE_PIXELS / height)
  );
}

function hasValidPngBitDepth(colorType: number, bitDepth: number): boolean {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth);
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    case 3:
      return [1, 2, 4, 8].includes(bitDepth);
    default:
      return false;
  }
}

/**
 * Validate PNG framing without inflating attacker-controlled pixels.
 *
 * The complete chunk stream and CRCs are checked, IHDR dimensions are bounded,
 * and a non-empty IDAT plus terminal IEND are required. Gotenberg remains the
 * decoder of record and will reject invalid compressed image data.
 */
function isSafePng(buffer: Buffer): boolean {
  if (!startsWith(buffer, PNG_MAGIC) || buffer.length < PNG_MAGIC.length + 25) return false;

  let cursor = PNG_MAGIC.length;
  let chunkCount = 0;
  let bitDepth = -1;
  let colorType = -1;
  let hasIhdr = false;
  let hasPlte = false;
  let hasIdat = false;
  let idatEnded = false;

  while (cursor < buffer.length && chunkCount < MAX_PNG_CHUNKS) {
    chunkCount += 1;
    if (cursor + 12 > buffer.length) return false;
    const dataBytes = buffer.readUInt32BE(cursor);
    const typeOffset = cursor + 4;
    const dataOffset = cursor + 8;
    if (dataBytes > buffer.length - dataOffset - 4) return false;
    const crcOffset = dataOffset + dataBytes;
    const nextChunk = crcOffset + 4;
    const chunkType = buffer.subarray(typeOffset, dataOffset).toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(chunkType) || chunkType[2] !== chunkType[2]?.toUpperCase()) {
      return false;
    }
    if (crc32(buffer, typeOffset, crcOffset) !== buffer.readUInt32BE(crcOffset)) return false;

    // Reject unknown critical chunks. Ancillary chunks are safe to preserve and
    // are interpreted only inside the isolated converter.
    if (chunkType[0] === chunkType[0]?.toUpperCase() &&
        !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(chunkType)) {
      return false;
    }

    if (chunkType === 'IHDR') {
      if (hasIhdr || chunkCount !== 1 || dataBytes !== 13) return false;
      const width = buffer.readUInt32BE(dataOffset);
      const height = buffer.readUInt32BE(dataOffset + 4);
      bitDepth = buffer[dataOffset + 8];
      colorType = buffer[dataOffset + 9];
      if (
        !hasSafeImageDimensions(width, height) ||
        !hasValidPngBitDepth(colorType, bitDepth) ||
        buffer[dataOffset + 10] !== 0 ||
        buffer[dataOffset + 11] !== 0 ||
        ![0, 1].includes(buffer[dataOffset + 12])
      ) {
        return false;
      }
      hasIhdr = true;
    } else if (!hasIhdr) {
      return false;
    } else if (chunkType === 'PLTE') {
      if (hasPlte || hasIdat || dataBytes === 0 || dataBytes > 768 || dataBytes % 3 !== 0) {
        return false;
      }
      if (colorType === 0 || colorType === 4) return false;
      if (colorType === 3 && dataBytes / 3 > 2 ** bitDepth) return false;
      hasPlte = true;
    } else if (chunkType === 'IDAT') {
      if (idatEnded || dataBytes === 0 || (colorType === 3 && !hasPlte)) return false;
      hasIdat = true;
    } else if (chunkType === 'IEND') {
      return dataBytes === 0 && hasIdat && nextChunk === buffer.length;
    } else if (hasIdat) {
      idatEnded = true;
    }

    cursor = nextChunk;
  }

  return false;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

/**
 * Walk JPEG marker segments and entropy scans through the exact EOI byte.
 * Dimensions come from a real SOF segment and are bounded before conversion;
 * EXIF (including orientation) stays untouched for LibreOffice to interpret.
 */
function isSafeJpeg(buffer: Buffer): boolean {
  if (!startsWith(buffer, JPEG_MAGIC) || buffer.length < 16) return false;

  let cursor = JPEG_MAGIC.length;
  let hasFrame = false;
  let hasScan = false;
  let hasEntropyData = false;
  let segmentCount = 0;
  let scanCount = 0;

  while (cursor < buffer.length) {
    segmentCount += 1;
    if (segmentCount > MAX_JPEG_SEGMENTS) return false;
    if (buffer[cursor] !== 0xff) return false;
    while (cursor < buffer.length && buffer[cursor] === 0xff) cursor += 1;
    if (cursor >= buffer.length) return false;
    const marker = buffer[cursor];
    cursor += 1;

    if (marker === 0xd9) {
      return hasFrame && hasScan && hasEntropyData && cursor === buffer.length;
    }
    // SOI may only occur at byte zero. TEM/restart markers are meaningful only
    // inside entropy data and cannot stand alone in this structural walk.
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)) {
      return false;
    }
    if (cursor + 2 > buffer.length) return false;
    const segmentBytes = buffer.readUInt16BE(cursor);
    if (segmentBytes < 2 || segmentBytes > buffer.length - cursor) return false;
    const dataOffset = cursor + 2;

    if (isJpegStartOfFrame(marker)) {
      if (segmentBytes < 11) return false;
      const height = buffer.readUInt16BE(dataOffset + 1);
      const width = buffer.readUInt16BE(dataOffset + 3);
      const components = buffer[dataOffset + 5];
      if (
        !hasSafeImageDimensions(width, height) ||
        components === 0 ||
        segmentBytes !== 8 + components * 3
      ) {
        return false;
      }
      hasFrame = true;
    }

    cursor += segmentBytes;
    if (marker !== 0xda) continue;

    scanCount += 1;
    if (!hasFrame || scanCount > MAX_JPEG_SCANS) return false;
    const scanComponents = buffer[dataOffset];
    if (scanComponents === 0 || segmentBytes !== 6 + scanComponents * 2) return false;
    hasScan = true;

    let foundNextMarker = false;
    while (cursor < buffer.length) {
      if (buffer[cursor] !== 0xff) {
        hasEntropyData = true;
        cursor += 1;
        continue;
      }
      const markerStart = cursor;
      while (cursor < buffer.length && buffer[cursor] === 0xff) cursor += 1;
      if (cursor >= buffer.length) return false;
      const scanMarker = buffer[cursor];
      if (scanMarker === 0x00) {
        hasEntropyData = true;
        cursor += 1;
        continue;
      }
      if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
        cursor += 1;
        continue;
      }
      cursor = markerStart;
      foundNextMarker = true;
      break;
    }
    if (!foundNextMarker) return false;
  }

  return false;
}

export function isPdfBuffer(buffer: Buffer): boolean {
  if (!startsWith(buffer, PDF_MAGIC) || buffer.length < 16) return false;
  const version = buffer.subarray(PDF_MAGIC.length, PDF_MAGIC.length + 3).toString('ascii');
  if ((!/^1\.[0-7]$/.test(version) && version !== '2.0') ||
      !isPdfWhitespace(buffer[PDF_MAGIC.length + 3])) {
    return false;
  }

  const eofOffset = buffer.lastIndexOf(PDF_EOF);
  if (eofOffset < 0) return false;
  for (let offset = eofOffset + PDF_EOF.length; offset < buffer.length; offset += 1) {
    if (!isPdfWhitespace(buffer[offset])) return false;
  }

  const startXrefOffset = buffer.lastIndexOf(PDF_STARTXREF, eofOffset);
  if (startXrefOffset < 0) return false;
  let cursor = startXrefOffset + PDF_STARTXREF.length;
  if (cursor >= eofOffset || !isPdfWhitespace(buffer[cursor])) return false;
  cursor = skipPdfWhitespace(buffer, cursor, eofOffset);
  const digitsStart = cursor;
  while (cursor < eofOffset && isAsciiDigit(buffer[cursor])) cursor += 1;
  if (cursor === digitsStart || cursor >= eofOffset || !isPdfWhitespace(buffer[cursor])) return false;
  const xrefDigits = buffer.subarray(digitsStart, cursor).toString('ascii');
  cursor = skipPdfWhitespace(buffer, cursor, eofOffset);
  if (cursor !== eofOffset) return false;

  let xrefOffset: number;
  try {
    const parsed = BigInt(xrefDigits);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    xrefOffset = Number(parsed);
  } catch {
    return false;
  }
  if (xrefOffset < 0 || xrefOffset >= startXrefOffset) return false;

  return isClassicXrefAt(buffer, xrefOffset, startXrefOffset) ||
    isXrefStreamAt(buffer, xrefOffset, startXrefOffset);
}

function isPdfWhitespace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c ||
    byte === 0x0d || byte === 0x20;
}

function isAsciiDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isPdfDelimiter(byte: number | undefined): boolean {
  return byte === undefined || isPdfWhitespace(byte) ||
    byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e ||
    byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d ||
    byte === 0x2f || byte === 0x25;
}

function skipPdfWhitespace(buffer: Buffer, cursor: number, end: number): number {
  while (cursor < end && isPdfWhitespace(buffer[cursor])) cursor += 1;
  return cursor;
}

function skipPdfWhitespaceAndComments(buffer: Buffer, cursor: number, end: number): number {
  while (cursor < end) {
    cursor = skipPdfWhitespace(buffer, cursor, end);
    if (cursor >= end || buffer[cursor] !== 0x25) return cursor;
    while (cursor < end && buffer[cursor] !== 0x0a && buffer[cursor] !== 0x0d) cursor += 1;
  }
  return cursor;
}

function consumeClassicXrefEntry(buffer: Buffer, cursor: number, end: number): number {
  const fileOffsetStart = cursor;
  while (cursor < end && isAsciiDigit(buffer[cursor])) cursor += 1;
  if (cursor - fileOffsetStart !== 10 || !isPdfWhitespace(buffer[cursor])) return -1;
  while (cursor < end && (buffer[cursor] === 0x20 || buffer[cursor] === 0x09)) cursor += 1;

  const generationStart = cursor;
  while (cursor < end && isAsciiDigit(buffer[cursor])) cursor += 1;
  if (cursor - generationStart !== 5 || !isPdfWhitespace(buffer[cursor])) return -1;
  while (cursor < end && (buffer[cursor] === 0x20 || buffer[cursor] === 0x09)) cursor += 1;

  if (buffer[cursor] !== 0x66 && buffer[cursor] !== 0x6e) return -1;
  cursor += 1;
  while (cursor < end && (buffer[cursor] === 0x20 || buffer[cursor] === 0x09)) cursor += 1;
  if (buffer[cursor] === 0x0d) {
    cursor += 1;
    return buffer[cursor] === 0x0a ? cursor + 1 : cursor;
  }
  return buffer[cursor] === 0x0a ? cursor + 1 : -1;
}

function isClassicXrefAt(buffer: Buffer, offset: number, end: number): boolean {
  if (!buffer.subarray(offset, offset + 4).equals(Buffer.from('xref', 'ascii')) ||
      !isPdfWhitespace(buffer[offset + 4])) {
    return false;
  }

  let cursor = skipPdfWhitespaceAndComments(buffer, offset + 4, end);
  let subsectionCount = 0;
  while (cursor < end) {
    if (
      buffer.subarray(cursor, cursor + 7).equals(Buffer.from('trailer', 'ascii')) &&
      isPdfDelimiter(buffer[cursor + 7])
    ) {
      return subsectionCount > 0;
    }

    const firstObjectStart = cursor;
    cursor = consumePdfInteger(buffer, cursor, end);
    if (cursor < 0 || !isPdfWhitespace(buffer[cursor])) return false;
    const firstObject = Number(buffer.subarray(firstObjectStart, cursor).toString('ascii'));
    if (!Number.isSafeInteger(firstObject)) return false;
    cursor = skipPdfWhitespace(buffer, cursor, end);

    const entryCountStart = cursor;
    cursor = consumePdfInteger(buffer, cursor, end);
    if (cursor < 0 || !isPdfWhitespace(buffer[cursor])) return false;
    const entryCount = Number(buffer.subarray(entryCountStart, cursor).toString('ascii'));
    if (
      !Number.isSafeInteger(entryCount) ||
      entryCount <= 0 ||
      entryCount > Math.floor((end - cursor) / 18)
    ) {
      return false;
    }
    cursor = skipPdfWhitespace(buffer, cursor, end);
    for (let index = 0; index < entryCount; index += 1) {
      cursor = consumeClassicXrefEntry(buffer, cursor, end);
      if (cursor < 0) return false;
    }
    subsectionCount += 1;
    cursor = skipPdfWhitespaceAndComments(buffer, cursor, end);
  }
  return false;
}

function consumePdfInteger(buffer: Buffer, cursor: number, end: number): number {
  const start = cursor;
  while (cursor < end && isAsciiDigit(buffer[cursor])) cursor += 1;
  return cursor === start ? -1 : cursor;
}

function skipPdfLiteralString(buffer: Buffer, cursor: number, end: number): number {
  let depth = 1;
  cursor += 1;
  while (cursor < end && depth > 0) {
    const byte = buffer[cursor];
    if (byte === 0x5c) {
      cursor += 2;
      continue;
    }
    if (byte === 0x28) depth += 1;
    if (byte === 0x29) depth -= 1;
    cursor += 1;
  }
  return depth === 0 ? cursor : -1;
}

function hasTopLevelXrefTypeAndFindDictionaryEnd(
  buffer: Buffer,
  dictionaryStart: number,
  end: number,
): number {
  let cursor = dictionaryStart + 2;
  let depth = 1;
  let hasXrefType = false;

  while (cursor < end) {
    const byte = buffer[cursor];
    if (byte === 0x25) {
      cursor = skipPdfWhitespaceAndComments(buffer, cursor, end);
      continue;
    }
    if (byte === 0x28) {
      cursor = skipPdfLiteralString(buffer, cursor, end);
      if (cursor < 0) return -1;
      continue;
    }
    if (byte === 0x3c && buffer[cursor + 1] === 0x3c) {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (byte === 0x3e && buffer[cursor + 1] === 0x3e) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return hasXrefType ? cursor : -1;
      continue;
    }
    if (byte === 0x3c) {
      cursor += 1;
      while (cursor < end && buffer[cursor] !== 0x3e) cursor += 1;
      if (cursor >= end) return -1;
      cursor += 1;
      continue;
    }
    if (
      depth === 1 &&
      buffer.subarray(cursor, cursor + 5).equals(Buffer.from('/Type', 'ascii')) &&
      isPdfDelimiter(buffer[cursor + 5])
    ) {
      const valueOffset = skipPdfWhitespaceAndComments(buffer, cursor + 5, end);
      if (
        buffer.subarray(valueOffset, valueOffset + 5).equals(Buffer.from('/XRef', 'ascii')) &&
        isPdfDelimiter(buffer[valueOffset + 5])
      ) {
        hasXrefType = true;
      }
    }
    cursor += 1;
  }
  return -1;
}

function isXrefStreamAt(buffer: Buffer, offset: number, startXrefOffset: number): boolean {
  const end = Math.min(startXrefOffset, offset + 1024 * 1024);
  let cursor = consumePdfInteger(buffer, offset, end);
  if (cursor < 0 || cursor >= end || !isPdfWhitespace(buffer[cursor])) return false;
  cursor = skipPdfWhitespace(buffer, cursor, end);
  cursor = consumePdfInteger(buffer, cursor, end);
  if (cursor < 0 || cursor >= end || !isPdfWhitespace(buffer[cursor])) return false;
  cursor = skipPdfWhitespace(buffer, cursor, end);
  if (!buffer.subarray(cursor, cursor + 3).equals(Buffer.from('obj', 'ascii')) ||
      !isPdfDelimiter(buffer[cursor + 3])) {
    return false;
  }
  cursor = skipPdfWhitespaceAndComments(buffer, cursor + 3, end);
  if (buffer[cursor] !== 0x3c || buffer[cursor + 1] !== 0x3c) return false;
  cursor = hasTopLevelXrefTypeAndFindDictionaryEnd(buffer, cursor, end);
  if (cursor < 0) return false;
  cursor = skipPdfWhitespaceAndComments(buffer, cursor, end);
  return buffer.subarray(cursor, cursor + 6).equals(Buffer.from('stream', 'ascii')) &&
    isPdfWhitespace(buffer[cursor + 6]);
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  const minRecordBytes = 22;
  if (buffer.length < minRecordBytes) return -1;
  const firstCandidate = Math.max(0, buffer.length - minRecordBytes - 0xffff);
  for (let offset = buffer.length - minRecordBytes; offset >= firstCandidate; offset -= 1) {
    if (
      buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY &&
      offset + minRecordBytes + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      return offset;
    }
  }
  return -1;
}

function zipDataDescriptorEnd(
  buffer: Buffer,
  offset: number,
  limit: number,
  crc: number,
  compressedBytes: number,
  uncompressedBytes: number,
): number {
  const descriptorMatches = (valuesOffset: number): boolean =>
    valuesOffset + 12 <= limit &&
    buffer.readUInt32LE(valuesOffset) === crc &&
    buffer.readUInt32LE(valuesOffset + 4) === compressedBytes &&
    buffer.readUInt32LE(valuesOffset + 8) === uncompressedBytes;

  if (
    offset + 16 <= limit &&
    buffer.readUInt32LE(offset) === 0x08074b50 &&
    descriptorMatches(offset + 4)
  ) {
    return offset + 16;
  }
  return descriptorMatches(offset) ? offset + 12 : -1;
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
  let hasPackageRelationships = false;
  let hasWordDocument = false;
  const entryNames = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY) {
      return false;
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const modifiedTime = buffer.readUInt16LE(cursor + 12);
    const modifiedDate = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const recordBytes = 46 + nameBytes + extraBytes + commentBytes;
    if (
      (flags & 0x1) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      diskStart !== 0 ||
      localHeaderOffset === 0xffffffff ||
      cursor + recordBytes > buffer.length ||
      cursor + recordBytes > centralOffset + centralSize
    ) {
      return false;
    }

    const name = buffer.subarray(cursor + 46, cursor + 46 + nameBytes).toString('utf8');
    if (
      !name ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      entryNames.has(name)
    ) {
      return false;
    }
    entryNames.add(name);
    if (name === '[Content_Types].xml') hasContentTypes = true;
    if (name === '_rels/.rels') hasPackageRelationships = true;
    if (name === 'word/document.xml') hasWordDocument = true;

    if (
      localHeaderOffset + 30 > centralOffset ||
      buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      return false;
    }
    const localVersionNeeded = buffer.readUInt16LE(localHeaderOffset + 4);
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localModifiedTime = buffer.readUInt16LE(localHeaderOffset + 10);
    const localModifiedDate = buffer.readUInt16LE(localHeaderOffset + 12);
    const localCrc = buffer.readUInt32LE(localHeaderOffset + 14);
    const localCompressedBytes = buffer.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedBytes = buffer.readUInt32LE(localHeaderOffset + 22);
    const localNameBytes = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraBytes = buffer.readUInt16LE(localHeaderOffset + 28);
    const versionNeeded = buffer.readUInt16LE(cursor + 6);
    const localNameOffset = localHeaderOffset + 30;
    const localDataOffset = localNameOffset + localNameBytes + localExtraBytes;
    if (
      localDataOffset > centralOffset ||
      versionNeeded !== localVersionNeeded ||
      flags !== localFlags ||
      compressionMethod !== localCompressionMethod ||
      modifiedTime !== localModifiedTime ||
      modifiedDate !== localModifiedDate ||
      nameBytes !== localNameBytes ||
      !buffer.subarray(cursor + 46, cursor + 46 + nameBytes)
        .equals(buffer.subarray(localNameOffset, localNameOffset + localNameBytes))
    ) {
      return false;
    }

    const usesDataDescriptor = (flags & 0x08) !== 0;
    if (
      !usesDataDescriptor &&
      (crc !== localCrc ||
        compressedBytes !== localCompressedBytes ||
        uncompressedBytes !== localUncompressedBytes)
    ) {
      return false;
    }
    if (
      usesDataDescriptor &&
      !(
        (localCrc === 0 && localCompressedBytes === 0 && localUncompressedBytes === 0) ||
        (localCrc === crc &&
          localCompressedBytes === compressedBytes &&
          localUncompressedBytes === uncompressedBytes)
      )
    ) {
      return false;
    }

    const compressedDataEnd = localDataOffset + compressedBytes;
    if (!Number.isSafeInteger(compressedDataEnd) || compressedDataEnd > centralOffset) return false;
    const localRecordEnd = usesDataDescriptor
      ? zipDataDescriptorEnd(
        buffer,
        compressedDataEnd,
        centralOffset,
        crc,
        compressedBytes,
        uncompressedBytes,
      )
      : compressedDataEnd;
    if (localRecordEnd < 0 || localRecordEnd > centralOffset) return false;
    localRanges.push({ start: localHeaderOffset, end: localRecordEnd });

    if (
      compressedBytes > 0 &&
      uncompressedBytes / compressedBytes > MAX_DOCX_COMPRESSION_RATIO
    ) {
      return false;
    }
    if (compressedBytes === 0 && uncompressedBytes > 0) return false;
    if (compressionMethod === 0 && compressedBytes !== uncompressedBytes) return false;
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

  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) return false;
  }

  return (
    cursor === centralOffset + centralSize &&
    totalCompressed <= buffer.length &&
    hasContentTypes &&
    hasPackageRelationships &&
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
 * FAT/directory and finding a real WordDocument stream. JPEG and PNG inputs
 * require complete bounded image structure and safe dimensions. No document
 * payload is inflated, decoded or executed during detection.
 */
export function detectResumeFormat(buffer: Buffer): ResumeFormat {
  if (isPdfBuffer(buffer)) return 'pdf';

  if (startsWith(buffer, ZIP_MAGIC)) return isSafeDocxContainer(buffer) ? 'docx' : 'unknown';
  if (startsWith(buffer, OLE_MAGIC)) return isSafeLegacyDocContainer(buffer) ? 'doc' : 'unknown';
  if (startsWith(buffer, PNG_MAGIC)) return isSafePng(buffer) ? 'png' : 'unknown';
  if (startsWith(buffer, JPEG_MAGIC)) return isSafeJpeg(buffer) ? 'jpeg' : 'unknown';

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
      'DOCUMENT_CONVERTER_URL is required for non-PDF resume conversion',
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
  const stem = withoutControl.replace(/\.(?:pdf|docx?|docm|jpe?g|png)$/i, '').trim() || 'resume';
  return `${stem.slice(0, 120)}.pdf`;
}

function mimeFor(format: ConvertibleResumeFormat): string {
  const mimeByFormat: Record<ConvertibleResumeFormat, string> = {
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpeg: 'image/jpeg',
    png: 'image/png',
  };
  return mimeByFormat[format];
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

async function convertWithGotenberg(
  input: Buffer,
  format: ConvertibleResumeFormat,
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
    let errorBodyBytes = 0;
    try {
      errorBodyBytes = (
        await readBodyWithLimit(
          response,
          MAX_ERROR_BODY_BYTES,
          format,
          'CONVERTER_INVALID_RESPONSE',
          'dependency',
        )
      ).length;
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
      response: {
        status: response.status,
        trace: response.headers.get('gotenberg-trace'),
        error_body_bytes: errorBodyBytes,
      },
      status: response.status,
      durationMs: Date.now() - startedAt,
      error: `HTTP ${response.status}`,
    });
    throw new DocumentConversionError(
      isRequestRejection ? 'CONVERTER_REJECTED' : 'CONVERTER_UNAVAILABLE',
      isRequestRejection ? 'configuration' : 'dependency',
      `document converter returned HTTP ${response.status}`,
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
      'resume document is not a supported PDF, DOCX, DOC, JPEG or PNG file',
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

  const pdf = await convertWithGotenberg(input, format, options, maxOutputBytes);
  return {
    pdf,
    filename: outputFilename(filename),
    sourceFormat: format,
    converted: true,
    originalBytes: input.length,
    pdfBytes: pdf.length,
  };
}

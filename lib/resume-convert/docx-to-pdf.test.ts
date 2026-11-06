import { describe, it, expect } from 'vitest';
import { detectResumeFormat, convertDocxBufferToPdf, findChrome } from './docx-to-pdf';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('detectResumeFormat — 按 magic bytes 识别上传文件真实格式', () => {
  it('%PDF 开头 → pdf', () => {
    expect(detectResumeFormat(Buffer.from('%PDF-1.7\n…'))).toBe('pdf');
  });
  it('PK\\x03\\x04(zip 容器,docx)→ docx', () => {
    expect(detectResumeFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('docx');
  });
  it('D0 CF 11 E0(OLE2,老 .doc)→ doc', () => {
    expect(detectResumeFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]))).toBe('doc');
  });
  it('其它字节 → unknown(原样发,让解析端兜底)', () => {
    expect(detectResumeFormat(Buffer.from('hello'))).toBe('unknown');
    expect(detectResumeFormat(Buffer.alloc(0))).toBe('unknown');
  });
});

describe('convertDocxBufferToPdf — docx → PDF(mammoth + 系统 Chrome)', () => {
  it('真实最小 docx(含中文)→ 合法 PDF 字节', async () => {
    if (!findChrome()) return; // 无 Chrome 的环境跳过(CI 安全)
    // 用 zip 构造一个最小合法 docx(word/document.xml + [Content_Types].xml)
    const dir = mkdtempSync(join(tmpdir(), 'docx-fixture-'));
    try {
      writeFileSync(join(dir, '[Content_Types].xml'),
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
      execFileSync('mkdir', ['-p', join(dir, 'word')]);
      writeFileSync(join(dir, 'word/document.xml'),
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>陈思 简历 docx 转换测试 13800138000</w:t></w:r></w:p></w:body></w:document>');
      execFileSync('zip', ['-r', '-q', join(dir, 'out.docx'), '[Content_Types].xml', 'word'], { cwd: dir });
      const docx = readFileSync(join(dir, 'out.docx'));
      expect(detectResumeFormat(docx)).toBe('docx');

      const pdf = await convertDocxBufferToPdf(docx);
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF'); // 合法 PDF
      expect(pdf.length).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('非 docx 字节 → 抛错(调用方负责降级原样发)', async () => {
    await expect(convertDocxBufferToPdf(Buffer.from('not a docx'))).rejects.toThrow();
  });
});

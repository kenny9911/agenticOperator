// docx → PDF 转换(简历解析入口的格式护栏)。
//
// 背景:RoboHire parse-resume 只支持 PDF;此前任何上传字节都被冒充
// application/pdf 直发 —— docx 进来必然解析失败。本模块在解析前:
//   1. detectResumeFormat:按 magic bytes 识别真实格式(扩展名/事件 mime 不可信);
//   2. convertDocxBufferToPdf:docx → mammoth 提取 HTML(纯 JS,保段落/表格文本)
//      → 系统 Chrome headless 打印成 PDF(中文字体由系统渲染,零额外依赖)。
//
// 设计取舍:解析服务要的是「文字内容」,不是版式还原 —— mammoth+Chrome 足够;
// 不引 LibreOffice(重系统依赖)。老 .doc(OLE2)mammoth 不支持 → 调用方原样
// 发并由 UNPARSEABLE 路径兜底。转换失败一律抛错,由调用方决定降级。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mammoth from 'mammoth';

const execFileAsync = promisify(execFile);

export type ResumeFormat = 'pdf' | 'docx' | 'doc' | 'unknown';

/** 按文件头识别真实格式。PK=zip 容器(docx/xlsx 等,简历场景按 docx 处理);
 *  D0CF11E0=OLE2(老 .doc);%PDF=pdf;其余 unknown(原样发,让解析端兜底)。 */
export function detectResumeFormat(buf: Buffer): ResumeFormat {
  if (buf.length >= 4) {
    if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'docx';
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'doc';
  }
  return 'unknown';
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** 找系统 Chrome/Chromium(用于 HTML→PDF 打印);找不到返回 null(调用方降级)。 */
export function findChrome(): string | null {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/** docx 字节 → PDF 字节。非 docx / 无 Chrome / 转换失败 → 抛错(调用方降级)。 */
export async function convertDocxBufferToPdf(docx: Buffer): Promise<Buffer> {
  if (detectResumeFormat(docx) !== 'docx') {
    throw new Error('convertDocxBufferToPdf: input is not a docx (zip) container');
  }
  const chrome = findChrome();
  if (!chrome) {
    throw new Error('convertDocxBufferToPdf: no system Chrome/Chromium found (set CHROME_BIN)');
  }

  // mammoth:docx → HTML(段落/列表/表格文本;版式不重要,内容完整即可)。
  const { value: bodyHtml } = await mammoth.convertToHtml({ buffer: docx });
  if (!bodyHtml || !bodyHtml.trim()) {
    throw new Error('convertDocxBufferToPdf: mammoth extracted empty content');
  }
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;' +
    'font-size:12px;line-height:1.6;margin:32px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:2px 6px}' +
    '</style></head><body>' + bodyHtml + '</body></html>';

  const dir = mkdtempSync(join(tmpdir(), 'ao-docx2pdf-'));
  try {
    const htmlPath = join(dir, 'resume.html');
    const pdfPath = join(dir, 'resume.pdf');
    writeFileSync(htmlPath, html, 'utf-8');
    await execFileAsync(
      chrome,
      ['--headless', '--disable-gpu', '--no-sandbox', `--print-to-pdf=${pdfPath}`, '--no-pdf-header-footer', `file://${htmlPath}`],
      { timeout: 30_000 },
    );
    const pdf = readFileSync(pdfPath);
    if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error('convertDocxBufferToPdf: Chrome did not produce a valid PDF');
    }
    return pdf;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

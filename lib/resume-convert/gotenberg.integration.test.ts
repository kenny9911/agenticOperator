// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { prepareResumePdf } from './prepare-resume-pdf';

const SENTINEL = 'AO_CONVERT_SENTINEL_20260803';
const fixtures = join(process.cwd(), 'lib', 'resume-convert', 'fixtures');
const integration = process.env.RUN_GOTENBERG_INTEGRATION === '1' ? describe : describe.skip;

integration('Gotenberg real Office conversion (set RUN_GOTENBERG_INTEGRATION=1)', () => {
  let converterUrl: string;

  beforeAll(async () => {
    converterUrl = process.env.DOCUMENT_CONVERTER_URL?.trim() ?? '';
    if (!converterUrl) {
      throw new Error('RUN_GOTENBERG_INTEGRATION=1 requires DOCUMENT_CONVERTER_URL');
    }
    const response = await fetch(new URL('/health', converterUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Gotenberg health check failed with HTTP ${response.status}`);
    }
  });

  it.each(['docx', 'doc'] as const)(
    'converts a real %s file into an extractable PDF',
    async (format) => {
      const input = readFileSync(join(fixtures, `synthetic-resume.${format}`));
      const result = await prepareResumePdf(input, `synthetic-resume.${format}`, {
        converterUrl,
      });

      expect(result.sourceFormat).toBe(format);
      expect(result.converted).toBe(true);
      expect(result.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      const pdf = await getDocumentProxy(new Uint8Array(result.pdf));
      try {
        const { text, totalPages } = await extractText(pdf, { mergePages: true });
        const extracted = Array.isArray(text) ? text.join('\n') : text;
        expect(totalPages).toBeGreaterThanOrEqual(1);
        expect(extracted).toContain(SENTINEL);
        expect(extracted).toContain('测试候选人');
      } finally {
        await pdf.destroy();
      }
    },
    150_000,
  );
});

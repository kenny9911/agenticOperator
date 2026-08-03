// @vitest-environment node

import { NonRetriableError } from 'inngest';
import { describe, expect, it, vi } from 'vitest';
import { DocumentConversionError } from './prepare-resume-pdf';
import { routeDocumentConversionFailure } from './route-conversion-failure';

function conversionError(
  code: ConstructorParameters<typeof DocumentConversionError>[0],
  category: ConstructorParameters<typeof DocumentConversionError>[1],
): DocumentConversionError {
  return new DocumentConversionError(code, category, `${code} detail`, 'docx');
}

describe('routeDocumentConversionFailure', () => {
  it('marks a deterministic document failure before terminating non-retriably', async () => {
    const markUploadFailed = vi.fn().mockResolvedValue(undefined);
    const error = conversionError('UNSUPPORTED_FORMAT', 'document');

    await expect(routeDocumentConversionFailure(error, 'upload-1', {
      markUploadFailed,
    })).rejects.toBeInstanceOf(NonRetriableError);
    expect(markUploadFailed).toHaveBeenCalledWith('upload-1', error.message);
  });

  it('rethrows a failed state write so Inngest can retry it', async () => {
    const markError = new Error('partner pg unavailable');
    const onMarkFailure = vi.fn();
    const markUploadFailed = vi.fn().mockRejectedValue(markError);

    await expect(routeDocumentConversionFailure(
      conversionError('INPUT_TOO_LARGE', 'document'),
      'upload-2',
      { markUploadFailed, onMarkFailure },
    )).rejects.toBe(markError);
    expect(onMarkFailure).toHaveBeenCalledWith(markError);
  });

  it('parks a configuration/request failure without mutating upload state', async () => {
    const markUploadFailed = vi.fn();

    await expect(routeDocumentConversionFailure(
      conversionError('CONVERTER_REJECTED', 'configuration'),
      'upload-3',
      { markUploadFailed },
    )).rejects.toBeInstanceOf(NonRetriableError);
    expect(markUploadFailed).not.toHaveBeenCalled();
  });

  it('preserves the original dependency error for automatic retry', async () => {
    const markUploadFailed = vi.fn();
    const error = conversionError('CONVERTER_UNAVAILABLE', 'dependency');

    await expect(routeDocumentConversionFailure(error, 'upload-4', {
      markUploadFailed,
    })).rejects.toBe(error);
    expect(markUploadFailed).not.toHaveBeenCalled();
  });
});

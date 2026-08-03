import { NonRetriableError } from 'inngest';
import type { DocumentConversionError } from './prepare-resume-pdf';

export type RouteConversionFailureOptions = {
  markUploadFailed: (uploadId: string, errorMessage: string) => Promise<void>;
  onMarkFailure?: (error: unknown) => void;
};

/**
 * Apply the resume-upload state and retry contract for a conversion failure.
 *
 * - deterministic document defects are marked failed, then terminated;
 * - converter configuration/request defects terminate without blaming the file;
 * - converter availability defects keep the original retryable error.
 *
 * This function never returns. A failed partner-state write is deliberately
 * rethrown as-is so Inngest retries instead of leaving a pending upload behind.
 */
export async function routeDocumentConversionFailure(
  error: DocumentConversionError,
  uploadId: string,
  options: RouteConversionFailureOptions,
): Promise<never> {
  if (error.category === 'document') {
    try {
      await options.markUploadFailed(uploadId, error.message);
    } catch (markError) {
      options.onMarkFailure?.(markError);
      throw markError;
    }
    throw new NonRetriableError(
      `简历文件无法转换为 PDF · upload_id=${uploadId} code=${error.code}: ${error.message}`,
    );
  }

  if (!error.retryable) {
    throw new NonRetriableError(
      `文档转换服务配置/请求被拒绝 · upload_id=${uploadId} code=${error.code}: ${error.message}`,
    );
  }

  throw error;
}

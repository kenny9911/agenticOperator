// Function ① — 订阅 RESUME_DOWNLOADED → download PDF → parse → 持久化 → 发 RESUME_PROCESSED
//
// 流程 (per agentic-operator-onboarding v7 §4.8 + ADR-0011 边界):
//   1. RESUME_DOWNLOADED 带 transport 元数据和可选 expectation_payload。
//      raas **不**预先 parse — parse 是 agent 的职责；candidate expectation
//      则由 RAAS 上传入口直接提供，AO 不需要另改事件名等待补齐。
//   2. agent → GET /api/v1/resumes/uploads/<upload_id>/raw  (PDF bytes, RAAS MinIO)
//   3. agent → POST {RoboHire}/api/v1/parse-resume   (multipart — 直连 RoboHire, 不走 RAAS proxy)
//   4. agent → partner Postgres (Candidate + CandidateExpectation + Resume)
//      并同步 AllmetaOntology (Neo4j)。
//   5. agent → RESUME_PROCESSED 给下游 rule-check / matcher。
//
// Backward compat: 如果事件 payload 已经带 parsed.data (legacy 内部
// 路径或 partner 在 emit 前预 parse 过), 直接用事件里的 parsed,
// 跳过 step 2-3.
//
// etag 兜底: 事件里的 etag 可能是 null (RAAS 手动上传链路目前没填),
// agent 在拿到 PDF 字节后用 MD5 算一个本地 etag 作为 saveCandidate
// 的 dedup key.

import { createHash } from 'node:crypto';
import { NonRetriableError } from 'inngest';
import { getResumeBuffer, statResume } from '@/lib/minio';
import {
  saveCandidateToPartnerPg,
  markResumeUploadFailed,
  type SaveCandidateInput,
} from '@/lib/partner-pg/candidates';
import { isPartnerPgConfigured } from '@/lib/partner-pg/client';
import {
  writeCandidateInstance,
  writeCandidateExpectationInstance,
  writeResumeInstance,
} from '@/lib/allmeta-writers';
import { parseResumeDirect, RobohireApiError } from '@/lib/robohire-client';
import { extractCandidateExpectation } from '@/lib/mappers/candidate-preferences';
import {
  normalizeCandidateExpectationPayload,
} from '@/lib/raas-v1/candidate-expectation';
import { detectResumeFormat, convertDocxBufferToPdf } from '@/lib/resume-convert/docx-to-pdf';
import { classifyRobohire } from '@/lib/dependency-health/classify';
import { reportDependencyDegraded } from '@/lib/dependency-health/report';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import { inngest, type ResumeProcessedData } from '@/server/inngest/client';
import { skipIfRaasV1Paused } from '@/server/inngest/raas-v1';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { prisma } from '@/server/db';
import { notifyRecruitmentLifecycle } from '@/server/notifications/recruitment-lifecycle';
import { runLockCheck } from '@/lib/candidate-lock/run-lock-check';
// 查重(invoke 模式):落库前同步调用独立的「候选人查重」函数,拿结论驱动挂老档/新建。
import { candidateIdentityAgent } from '@/server/inngest/agents/candidate-identity-agent';
import { isRuleAuditPersistenceFailure } from '@/lib/rule-check/ontology-audit-writer';

// Local alias mirroring the RoboHire parse-resume `data` shape that we
// historically imported from raas-api-client.ts. After the 2026-05-20
// direct-write migration we use partner-pg + direct RoboHire, so this is
// just a structural alias.
type RaasParseResumeData = Record<string, unknown> & { name?: string | null };

const AGENT_ID = 'resume-parser-agent';

export const resumeParserAgent = inngest.createFunction(
  {
    id: 'resume-parser-agent',
    name: 'Resume Parser Agent',
    // 可恢复依赖故障由 reportDependencyDegraded 抛普通 Error，交给 Inngest
    // 自动重试；无效事件、文档不可解析等永久错误抛 NonRetriableError，仍然
    // 立即终止，不会重复扣费。每个持久化阶段都在稳定 step.run 内，重试复用
    // 已完成步骤，避免重复写 Partner PG / Allmeta。
    retries: 3,
    triggers: [{ event: 'RESUME_DOWNLOADED' }],
  },
  async ({ event, step, logger, runId }) => {
    const paused = await skipIfRaasV1Paused(AGENT_ID, logger);
    if (paused) return paused;

    // RESUME_DOWNLOADED 兼容两种 shape:
    //   A) RAAS canonical envelope —
    //      { entity_id, entity_type, event_id, payload: { ... }, trace }
    //   B) Flat (legacy / publish-test) —
    //      { upload_id, bucket, object_key, parsed, ... }
    const raw = unwrapDownloadedEnvelope(event.data);
    const expectationPayload = normalizeCandidateExpectationPayload(
      raw.expectation_payload ?? raw.expectationPayload,
    );
    const fileLogger = createAgentLogger({
      agent: 'resumeParser',
      runId: runId ?? `local-${Date.now()}`,
      traceId: getTraceId(event.data) ?? null,
      anchors: {
        upload_id: typeof raw.upload_id === 'string' ? raw.upload_id : undefined,
        bucket: typeof raw.bucket === 'string' ? raw.bucket : undefined,
        object_key: typeof raw.object_key === 'string' ? raw.object_key : undefined,
      },
    });
    return runWithLogger(fileLogger, async () => {
    fileLogger.event('handler.start', {
      event_name: event.name,
      upload_id: raw.upload_id ?? raw.uploadId,
      bucket: raw.bucket,
      object_key: raw.object_key ?? raw.objectKey,
      filename: raw.filename,
      employee_id: raw.employee_id ?? raw.employeeId ?? raw.operator_employee_id ?? null,
      locked_by_employee_id: raw.locked_by_employee_id ?? raw.lockedByEmployeeId ?? null,
      client_id: raw.client_id ?? null,
      job_requisition_id: raw.job_requisition_id ?? null,
      sourcing_channel_id: raw.sourcing_channel_id ?? raw.sourcingChannelId ?? null,
      hr_folder: raw.hr_folder ?? raw.hrFolder ?? null,
      expectation_payload_keys: expectationPayload
        ? Object.keys(expectationPayload).sort()
        : [],
      // Echo the raw event keys so missing fields are diagnosable from logs alone.
      _raw_keys: Object.keys(raw).sort(),
    });

    // 2026-05-26 — STEP 1 完整入参: RAAS → AO 原始 event envelope (RESUME_DOWNLOADED).
    fileLogger.event('handler.raw_input', {
      from: 'RAAS',
      to: 'AO.resumeParser',
      event_name: event.name,
      raw_event_data: event.data,
    });

    // ── 提取 anchor 字段 ──
    const upload_id = raw.upload_id ?? raw.uploadId;
    const bucket = raw.bucket;
    const object_key = raw.object_key ?? raw.objectKey;
    const eventEtag = raw.etag ?? null; // 可能是 null (RAAS 手动上传链路没填)
    const filename = raw.filename;
    const employeeId = raw.employee_id ?? raw.employeeId ?? raw.operator_employee_id ?? null;
    const operator_id = raw.operator_id ?? null;
    const client_id = raw.client_id ?? null;
    const job_requisition_id = raw.job_requisition_id ?? null;
    // RAAS Nextcloud 路径(ADR-0040)在 RESUME_DOWNLOADED 预填窄化后的客户需求 id
    // 数组:已按「文件名岗位名 × 招聘员名下在招岗位」模糊匹配收敛。透传给下游
    // ruleCheckAgent,使其直接对这些 JR 撮合,而非按 employee_id 扫名下全部在招岗位。
    const job_requisition_ids = normalizeJobRequisitionIds(
      raw.job_requisition_ids ?? raw.jobRequisitionIds,
    );
    const mime_type = raw.mime_type ?? raw.contentType ?? 'application/pdf';
    const file_size = raw.size ?? raw.file_size ?? null;
    // RAAS publishes sourcing_channel_id on RESUME_DOWNLOADED — pass it through
    // to partner Postgres so candidate.sourcing_channel_id reflects which
    // channel (BOSS直聘 / 猎聘 / LinkedIn / 人才库-AI / …) sourced the resume.
    // Accept both snake- and camelCase variants for forward compat.
    const sourcing_channel_id =
      typeof raw.sourcing_channel_id === 'string' && raw.sourcing_channel_id.trim()
        ? raw.sourcing_channel_id.trim()
        : typeof raw.sourcingChannelId === 'string' && raw.sourcingChannelId.trim()
          ? raw.sourcingChannelId.trim()
          : null;
    // RMHR 锁定归属透传 (raas 2026-05-27 起在 RESUME_DOWNLOADED 上发
    // locked_by_employee_id / locked_by_name / locked_at, c200efd)。锁持有人是
    // 候选人归属权威 — 被他人锁定时 AO 把候选人归属校正为锁持有人而非上传者
    // (per raas ADR-0041 "锁在他人则同步真实归属")。snake/camel 双形态兼容。
    const locked_by_employee_id =
      typeof raw.locked_by_employee_id === 'string' && raw.locked_by_employee_id.trim()
        ? raw.locked_by_employee_id.trim()
        : typeof raw.lockedByEmployeeId === 'string' && raw.lockedByEmployeeId.trim()
          ? raw.lockedByEmployeeId.trim()
          : null;
    // 归属生效值: 锁持有人优先, 无锁信息回落上传者。仅用于"归属"语义的写入
    // (candidate.employee_id / Neo4j Candidate.employee_id); resume.uploaded_by
    // 与 RESUME_PROCESSED.employee_id (matcher 按上传者扫名下岗位) 保持上传者。
    const ownerEmployeeId = locked_by_employee_id ?? employeeId;
    const traceId = getTraceId(event.data);

    // External-dependency-health context — passed to reportDependencyDegraded
    // when RoboHire is found dead (out-of-funds / fault / empty-200) so the run
    // fails instead of reporting false success, and the monitor can alert.
    const depCtx = {
      agent: 'ResumeParser',
      runId: runId ?? null,
      traceId: traceId ?? null,
      domain: RECRUITMENT_DOMAIN_ID,
      anchors: {
        upload_id: typeof upload_id === 'string' ? upload_id : undefined,
        job_requisition_id: typeof job_requisition_id === 'string' ? job_requisition_id : undefined,
        client_id: typeof client_id === 'string' ? client_id : undefined,
      },
    };

    if (!upload_id) {
      throw new NonRetriableError(
        `RESUME_DOWNLOADED missing upload_id — cannot anchor saveCandidate. data keys=${Object.keys(raw).join(',')}`,
      );
    }
    if (!bucket || !object_key) {
      throw new NonRetriableError(
        `RESUME_DOWNLOADED missing bucket/object_key — partner-pg saveCandidate 需要这两个字段做 Resume 去重`,
      );
    }
    if (!isPartnerPgConfigured()) {
      throw new NonRetriableError(
        `[resume-persist] RAAS_POSTGRES_URL env 未配置`,
      );
    }

    logger.info(
      `[resume-persist] received RESUME_DOWNLOADED · upload_id=${upload_id} ` +
        `bucket=${bucket} object_key=${object_key} filename=${filename ?? '—'} ` +
        `etag=${eventEtag ?? 'null'}`,
    );

    // ── 读取 parsed.data (legacy 路径: 事件 payload 已带 parsed) ──
    const parsedFromEvent = pickParsedData(raw);

    // ── 取 parsed + etag, 两条路径择一 ──
    let parsed: RaasParseResumeData;
    let robohireRequestId: string | undefined;
    let computedEtag: string | undefined;

    if (parsedFromEvent) {
      // Legacy: 事件已带 parsed.data, 跳过 download + parse.
      parsed = parsedFromEvent;
      logger.info(
        `[resume-persist] legacy path · 事件已带 parsed.data, 跳过 download+parse · ` +
          `name="${parsed.name ?? '?'}"`,
      );
    } else {
      // v7 §4.8 标准路径: 自己拉 PDF 字节 + 自己 parse.
      const stepKey = sanitize(String(upload_id));
      const downloadAndParse = await step.run(`download-and-parse-${stepKey}`, async () => {
        // 1) 直连 MinIO 下载 PDF 字节 (2026-05-20: 不再走 RAAS proxy)
        let pdfBuffer: Buffer;
        let minioContentType: string | null = null;
        try {
          pdfBuffer = await getResumeBuffer(String(bucket), String(object_key));
          try {
            const stat = await statResume(String(bucket), String(object_key));
            minioContentType = stat.contentType;
          } catch {
            // stat failure is non-fatal; we have the bytes
          }
        } catch (e) {
          // MinIO 404 / NoSuchKey → 不重试 (object 不存在,重试没意义)
          const msg = e instanceof Error ? e.message : String(e);
          if (/NoSuchKey|NotFound|404/i.test(msg)) {
            throw new NonRetriableError(
              `MinIO ${bucket}/${object_key} not found: ${msg}`,
            );
          }
          throw e;
        }
        logger.info(
          `[resume-persist] downloaded PDF from MinIO · upload_id=${upload_id} ` +
            `bytes=${pdfBuffer.length} content-type=${minioContentType ?? '—'} ` +
            `filename="${filename ?? '—'}"`,
        );

        // 1b) 格式护栏(2026-06-12):RoboHire 只支持 PDF,按 magic bytes 识别真实
        //     格式(扩展名/事件 mime 不可信)。docx → mammoth+系统 Chrome 转成 PDF
        //     再发;转换失败/老 .doc/unknown → 原样发,由 UNPARSEABLE 路径兜底。
        //     注意:saveCandidate 的 MD5 etag 仍用**原始字节**算(dedup 语义 = 同一
        //     上传文件),只有发给 RoboHire 的 buffer 换成转换后的 PDF。
        const rawFormat = detectResumeFormat(pdfBuffer);
        let parseBuffer = pdfBuffer;
        let parseFilename = (filename as string | undefined) ?? 'resume.pdf';
        if (rawFormat === 'docx') {
          try {
            parseBuffer = await convertDocxBufferToPdf(pdfBuffer);
            parseFilename = parseFilename.replace(/\.docx?$/i, '') + '.pdf';
            fileLogger.event('docx-converted', {
              upload_id,
              original_bytes: pdfBuffer.length,
              pdf_bytes: parseBuffer.length,
            });
            logger.info(
              `[resume-persist] docx → pdf converted · upload_id=${upload_id} ` +
                `${pdfBuffer.length}B → ${parseBuffer.length}B`,
            );
          } catch (e) {
            // 转换失败:原样发碰运气(RoboHire 拒了会走 UNPARSEABLE 终止),不在这里断链。
            fileLogger.event('docx-convert-failed', { upload_id, error: (e as Error).message });
            logger.warn(
              `[resume-persist] docx→pdf 转换失败,原样发 RoboHire 兜底 · ${(e as Error).message}`,
            );
          }
        } else if (rawFormat === 'doc' || rawFormat === 'unknown') {
          fileLogger.event('non-pdf-format', { upload_id, detected: rawFormat });
          logger.warn(
            `[resume-persist] 检测到非 PDF 格式 (${rawFormat}) · 原样发 RoboHire(老 .doc 不支持转换,建议上传方转 docx/pdf)`,
          );
        }

        // 2) POST /api/v1/parse-resume (multipart) — 直连 RoboHire
        const pdfFilename = parseFilename;
        let parseRes: Awaited<ReturnType<typeof parseResumeDirect>>;
        try {
          // 显式传 fileLogger → RoboHire parse-resume 完整 in/out 进 per-run 审计
          // (Inngest step.run 内 ALS 不可靠,必须显式传闭包 logger).
          parseRes = await parseResumeDirect(parseBuffer, pdfFilename, { traceId, logger: fileLogger });
        } catch (e) {
          // Document-content failure (image-only / scanned / corrupt PDF — RoboHire
          // truthfully reports "no extractable text"). This is NOT a vendor
          // degradation: do not pollute RoboHire health and do not park-and-retry a
          // document that will fail identically forever. Mark the upload terminally
          // failed so partner/RAAS stop re-driving it, then fail the run
          // NonRetriably with a content-level (not dependency) message.
          if (e instanceof RobohireApiError && e.code === 'UNPARSEABLE') {
            try {
              await markResumeUploadFailed(String(upload_id), e.message);
            } catch (markErr) {
              logger.warn(
                `[resume-persist] markResumeUploadFailed failed: ${(markErr as Error).message}`,
              );
            }
            fileLogger.event('parse.unparseable', { upload_id, error: e.message });
            throw new NonRetriableError(
              `简历无法解析(文档无可提取文字)· upload_id=${upload_id}: ${e.message}`,
            );
          }
          // Out-of-funds / fault / network — classify, record the dependency
          // signal, and throw (run fails/parks; quota auto-resumes after top-up).
          const oc = classifyRobohire('parseResume', e);
          if (!oc.ok) await reportDependencyDegraded(oc, depCtx);
          throw e; // an error always classifies as degraded; this also fails the run
        }
        // Silent degrade: 200 OK but RoboHire extracted nothing usable.
        const oc = classifyRobohire('parseResume', parseRes);
        if (!oc.ok) await reportDependencyDegraded(oc, depCtx);
        logger.info(
          `[resume-persist] RoboHire parse-resume OK · cached=${parseRes.cached} ` +
            `name="${parseRes.data?.name ?? '?'}" requestId=${parseRes.requestId}`,
        );

        // 3) 算 MD5 etag 作为 saveCandidate dedup 兜底.
        //    返回 primitive 给下个 step (Buffer 不能跨 step.run 序列化).
        const md5 = createHash('md5').update(pdfBuffer).digest('hex');

        return {
          // RobohireParseResumeData 与 RaasParseResumeData 形状 1:1 (RAAS 是
          // RoboHire 的 proxy), 但二者 TypeScript 类型不同源 — 这里 cast 一次,
          // 让下游 saveCandidate(SaveCandidateInput.parsed) 类型对齐.
          parsed: parseRes.data as unknown as RaasParseResumeData,
          robohire_request_id: parseRes.requestId,
          computed_etag: md5,
          cached: parseRes.cached,
        };
      });
      parsed = downloadAndParse.parsed;
      robohireRequestId = downloadAndParse.robohire_request_id;
      computedEtag = downloadAndParse.computed_etag;
    }

    // 最终 etag: 事件里的 (string) > 我们算的 MD5 > undefined
    const finalEtag =
      typeof eventEtag === 'string' && eventEtag.trim() ? eventEtag.trim() : computedEtag;

    // ── 查重(invoke 模式,2026-06-11):同步调用独立的「候选人查重」函数并等待结论。
    // 该函数只判定 + 落审计、不做任何存储操作(职责:查重=判定,解析=操作);它有
    // 自己的 run(舰队可管理/可下线)。落库前拿到 sameAsCandidateId 驱动挂老档/新建:
    //    强命中(auto-merged)→ same_as_candidate_id=老人 ID → 复用老行 UPDATE、新简历挂
    //    老 Candidate(1:N);弱信号/无命中 → null → 走正常 dedup/新建。
    // soft-fail:函数下线/超时/出错 → catch 后按「新候选人」降级,主流程零阻塞。
    interface IdentityVerdict {
      sameAsCandidateId?: string | null;
      dedupAction?: string;
      matchedCandidateId?: string | null;
      error?: string;
    }
    let identityVerdict: IdentityVerdict | null = null;
    if (process.env.CANDIDATE_IDENTITY_ENABLED !== '0') {
      try {
        identityVerdict = (await step.invoke('invoke-candidate-dedup', {
          function: candidateIdentityAgent,
          data: {
            upload_id: String(upload_id),
            resume_id: raw.resume_id ?? null,
            trace_id: null,
            invoked_by: 'resume-parser',
            // 候选人尚未建库 → candidate_id 用 upload_id 占位(self 排除无影响)。
            candidate_id: String(upload_id),
            parsed: { data: parsed },
          },
          timeout: '90s',
        })) as unknown as IdentityVerdict | null;
        fileLogger.event('candidate-identity.verdict', {
          upload_id,
          dedup_action: identityVerdict?.dedupAction ?? null,
          same_as_candidate_id: identityVerdict?.sameAsCandidateId ?? null,
          matched_candidate_id: identityVerdict?.matchedCandidateId ?? null,
          error: identityVerdict?.error ?? null,
        });
      } catch (e) {
        // A business lookup can degrade, but an authoritative rule decision may
        // never advance without its durable audit row. Propagate this tagged
        // failure so the parent Inngest run retries before candidate storage.
        if (isRuleAuditPersistenceFailure(e)) throw e;
        // 查重函数被下线/超时 → 按新候选人降级,绝不阻塞入库。
        fileLogger.event('candidate-identity.invoke_failed', { upload_id, error: (e as Error).message });
        identityVerdict = null;
      }
    }
    const sameAsCandidateId = identityVerdict?.sameAsCandidateId ?? null;

    // ── 直写 Partner Postgres (2026-05-20: 不再走 RAAS API) ──
    const saveResult = await step.run('save-candidate', async () => {
      const input: SaveCandidateInput = {
        upload_id: String(upload_id),
        bucket: String(bucket),
        object_key: String(object_key),
        etag: finalEtag,
        size: typeof file_size === 'number' ? file_size : null,
        filename: filename ?? undefined,
        employee_id: employeeId ?? undefined,
        locked_by_employee_id: locked_by_employee_id ?? undefined,
        client_id: client_id ?? undefined,
        job_requisition_id: job_requisition_id ?? undefined,
        sourcing_channel_id: sourcing_channel_id ?? undefined,
        expectation_payload: expectationPayload,
        // 同一人 → 复用老 candidate_id(UPDATE 挂新简历到老 Candidate,1:N);null → 走兜底 dedup。
        same_as_candidate_id: sameAsCandidateId ?? undefined,
        parsed: { data: parsed as Record<string, unknown> },
      };

      try {
        const r = await saveCandidateToPartnerPg(input);
        logger.info(
          `[resume-persist] ✅ partner-pg saveCandidate OK · candidate_id=${r.candidate_id} ` +
            `resume_id=${r.resume_id} application_id=${r.application_id ?? '—'} ` +
            `candidate_expectation_id=${r.candidate_expectation_id ?? '—'} ` +
            `candidate_created=${r.candidate_created} resume_created=${r.resume_created}`,
        );
        fileLogger.event('save-candidate.ok', {
          from: 'AO.resumeParser',
          to: '候选人数据库',
          upload_id,
          candidate_id: r.candidate_id,
          resume_id: r.resume_id,
          candidate_expectation_id: r.candidate_expectation_id,
          application_id: r.application_id,
          candidate_created: r.candidate_created,
          resume_created: r.resume_created,
          full_input_to_save: input,        // 完整传给 saveCandidateToPartnerPg 的入参
          full_robohire_parsed: parsed,     // 完整 RoboHire parse-resume 输出
        });
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Mark the upload as failed in partner's state-machine table so RAAS
        // sees a terminal error instead of an indefinite 'pending'. Non-fatal
        // — if this write itself fails, swallow and re-throw the original.
        try {
          await markResumeUploadFailed(String(upload_id), msg);
        } catch (markErr) {
          logger.warn(
            `[resume-persist] markResumeUploadFailed failed: ${(markErr as Error).message}`,
          );
        }
        fileLogger.event('save-candidate.failed', { upload_id, error: msg });
        throw e;
      }
    });

    // ── 5b. 写 Neo4j Candidate + Candidate_Expectation + Resume via Allmeta ──
    const stepKeyForNeo4j = sanitize(String(upload_id));
    await step.run(`write-candidate-neo4j-${stepKeyForNeo4j}`, async () => {
      const r = await writeCandidateInstance({
        candidate_id: saveResult.candidate_id,
        // 归属语义 — 锁持有人优先 (c200efd)。resume.uploaded_by / writeResumeInstance
        // 仍记上传者; 仅 Candidate 归属随 RMHR 锁权威。
        employee_id: ownerEmployeeId,
        parsed: parsed as unknown as Record<string, unknown>,
      });
      if (r.ok) {
        logger.info(`[resume-persist] ✓ allmeta wrote Candidate ${saveResult.candidate_id}`);
        if (r.nameWasPlaceholder) {
          logger.warn(
            `[resume-persist] name parse miss → fallback '未命名候选人' candidate_id=${saveResult.candidate_id} parsed_name_raw=${JSON.stringify(r.parsedNameRaw)}`,
          );
          // Fire-and-forget observability event — never break the agent run
          prisma.agentActivity.create({
            data: {
              runId: runId ?? null,
              nodeId: '9-1',
              agentName: 'ResumeParser',
              type: 'warn',
              narrative: `候选人名字解析失败 → fallback '未命名候选人' (candidate_id=${saveResult.candidate_id})`,
              metadata: JSON.stringify({
                kind: 'name_parse_miss',
                candidate_id: saveResult.candidate_id,
                parsed_name_raw: r.parsedNameRaw,
              }),
            },
          }).catch(() => { /* never break the agent run on observability */ });
        }
      } else {
        logger.warn(`[resume-persist] allmeta Candidate write failed: ${r.error}`);
      }
      return r;
    });
    if (expectationPayload) {
      const candidateExpectationId = saveResult.candidate_expectation_id;
      if (!candidateExpectationId) {
        throw new Error(
          `[resume-persist] expectation_payload was received but partner-pg returned no candidate_expectation_id`,
        );
      }
      await step.run(`write-candidate-expectation-neo4j-${stepKeyForNeo4j}`, async () => {
        const r = await writeCandidateExpectationInstance({
          candidate_expectation_id: candidateExpectationId,
          candidate_id: saveResult.candidate_id,
          expectation: expectationPayload,
        });
        if (r.ok) {
          logger.info(
            `[resume-persist] ✓ allmeta wrote Candidate_Expectation ${candidateExpectationId}`,
          );
        } else {
          logger.warn(
            `[resume-persist] allmeta Candidate_Expectation write failed: ${r.error}`,
          );
        }
        return r;
      });
    }
    await step.run(`write-resume-neo4j-${stepKeyForNeo4j}`, async () => {
      const r = await writeResumeInstance({
        resume_id: saveResult.resume_id,
        candidate_id: saveResult.candidate_id,
        job_requisition_id: job_requisition_id ?? null,
        employee_id: employeeId,
        file_path: object_key,
        parsed: parsed as unknown as Record<string, unknown>,
      });
      if (r.ok) logger.info(`[resume-persist] ✓ allmeta wrote Resume ${saveResult.resume_id}`);
      else logger.warn(`[resume-persist] allmeta Resume write failed: ${r.error}`);
      return r;
    });
    // Application instance write removed (2026-05-21) — RAAS owns Application
    // creation in both partner Postgres and ontology Neo4j now. AO's role is
    // only to surface application_id in downstream events when it's already
    // there; we never mint or write Application rows.

    // ── 5c. RMHR 锁定校验 (candidate-lock alignment, 2026-06-08) ──
    // 2026-06-11 锁定 agent 暂下线:LOCK_CHECK_ENABLED!=='1' 时连 step 都不进
    // (运行轨迹里不再出现 rmhr-lock-check,主流程零影响);恢复 = 打开开关,代码不动。
    // 开启时:调公司 RMHR uploadByRecruiterEmail(上传+锁定合一)拿当前锁定真相、
    // 刷新 AO 认知并据此放行/拦截。
    const lockResult =
      process.env.LOCK_CHECK_ENABLED === '1'
        ? await step.run('rmhr-lock-check', async () =>
            runLockCheck({
              candidateId: saveResult.candidate_id,
              uploadId: String(upload_id),
              employeeId,
              bucket: bucket ? String(bucket) : null,
              objectKey: object_key ? String(object_key) : null,
              filename: (filename ?? 'resume.pdf').trim(),
              sourcingChannelId: sourcing_channel_id,
              clientId: client_id ?? null,
              hasFileBytes: !parsedFromEvent,
              logger,
            }),
          )
        : null;
    // 只有显式开启 LOCK_CHECK_ENFORCE 时,lock-only 才真正拦截下游(默认关=不拦,
    // dark-launch 期只观察 lockResult、不改 announce 行为)。
    const lockOnly =
      process.env.LOCK_CHECK_ENFORCE === '1' && lockResult?.decision === 'lock-only';

    // ── emit RESUME_PROCESSED 触发下游 rule-check / matcher ──
    // Note: 在 v7 §4.8 下,RAAS 自己在 saveCandidate 后也会按规则发
    // RESUME_PROCESSED 给下游 matching 流程. 我们这里 dual-track 也
    // emit 一份做兜底 — 因为 partner 那边的 auto-emit 不一定全路径覆盖.
    // 等 partner 那边稳定后可以去掉这个 emit (TODO @ partner verify).
    const candidateExpectationForMatching = expectationPayload
      ? extractCandidateExpectation({
          parsed: expectationPayload as Record<string, unknown>,
          rawText: null,
        })
      : extractCandidateExpectation({
          parsed: parsed as Record<string, unknown>,
          rawText:
            typeof (parsed as Record<string, unknown>)?.rawText === 'string'
              ? ((parsed as Record<string, unknown>).rawText as string)
              : null,
        });

    const processedPayload: ResumeProcessedData = {
      // 透传 transport 字段供下游使用
      bucket,
      objectKey: object_key,
      filename: (filename ?? 'resume.pdf').trim(),
      hrFolder: raw.hr_folder ?? raw.hrFolder ?? null,
      employeeId,
      etag: finalEtag ?? null,
      size: typeof file_size === 'number' ? file_size : null,
      sourceEventName: raw.source_event_name ?? raw.sourceEventName ?? null,
      receivedAt: raw.received_at ?? raw.receivedAt ?? new Date().toISOString(),
      // 给 matcher 用的 anchor
      upload_id,
      employee_id: employeeId ?? undefined,
      // parsed.data 透传 (matcher 仍可以用作 resume text 来源)
      parsed: { data: parsed as unknown as Record<string, unknown> },
      // 持久化的产物 — 让下游知道 candidate_id 已经存在
      candidate_id: saveResult.candidate_id,
      resume_id: saveResult.resume_id,
      // 透传上传时关联的岗位 — matchResumeAgent 据此决定"单岗位精准匹配"
      // 还是"上传者名下全部 recruiting 岗位扫描"。
      job_requisition_id: job_requisition_id ?? null,
      // ADR-0040 — RAAS 预填的窄化 JR 数组(单数 job_requisition_id 为空时,
      // ruleCheckAgent 直接循环这些 id 取详情撮合,跳过 path-B 名下全量扫描)。
      job_requisition_ids: job_requisition_ids.length > 0 ? job_requisition_ids : undefined,
      // 透传 RAAS 上游传来的 sourcing_channel_id / client_id,partner / 重新订阅方都需要
      sourcing_channel_id: sourcing_channel_id ?? null,
      client_id: client_id ?? null,
      // 老的 4 对象嵌套字段保留为空 (RAAS 不再要求 agent 转结构)
      candidate: {} as ResumeProcessedData['candidate'],
      // RAAS expectation_payload 是权威来源；转换为 matcher 的数组/数值结构。
      // 旧事件没有该字段时，才从 RoboHire 解析结果 / rawText 尽力抽取。
      candidate_expectation: candidateExpectationForMatching,
      resume: {} as ResumeProcessedData['resume'],
      runtime: {} as ResumeProcessedData['runtime'],
      parsedAt: new Date().toISOString(),
      parserVersion: 'v7-pull-model@2026-05-08',
    };

    // 2026-05-21: explicit upload_id pass-through audit so logs prove every
    // RESUME_PROCESSED emit carries upload_id (partner / RAAS subscribers
    // anchor on this field).
    fileLogger.event('emit.resume-processed', {
      from: 'AO.resumeParser',
      to: 'AO.ruleCheck + RAAS (Inngest event RESUME_PROCESSED)',
      upload_id,
      candidate_id: saveResult.candidate_id,
      resume_id: saveResult.resume_id,
      application_id: saveResult.application_id,
      job_requisition_id: job_requisition_id ?? null,
      sourcing_channel_id: sourcing_channel_id ?? null,
      client_id: client_id ?? null,
      filename: (filename ?? 'resume.pdf').trim(),
      bucket,
      object_key,
      full_payload: processedPayload,    // 完整 emit payload (含 parsed.data, snapshot 等)
    });
    if (!lockOnly) {
      await step.sendEvent('emit-resume-processed', {
        name: 'RESUME_PROCESSED',
        data: processedPayload,
      });
      await notifyRecruitmentLifecycle(step, 'RESUME_PROCESSED', {
        anchors: {
          candidate_id: saveResult.candidate_id,
          upload_id,
          resume_id: saveResult.resume_id,
          client_id: client_id ?? null,
        },
        runId: runId ?? null,
        traceId,
      });
    } else {
      // 锁定冲突 lock-only:候选人已被他人锁定/保护/黑名单 → 不跑该上传者的匹配,
      // 但发一个显式 RESUME_LOCKED_CONFLICT 让运营看得到(可见不可处理)。
      await step.sendEvent('emit-resume-locked-conflict', {
        name: 'RESUME_LOCKED_CONFLICT',
        data: {
          upload_id,
          candidate_id: saveResult.candidate_id,
          resume_id: saveResult.resume_id,
          current_owner_employee_id: lockResult?.lockOwnerEmployeeId ?? null,
          current_owner_email: lockResult?.lockByEmail ?? null,
          reason: lockResult?.reason ?? null,
        },
      });
      logger.info(
        `[resume-persist] 🔒 lock-only · candidate ${saveResult.candidate_id} ` +
          `owned by ${lockResult?.lockByEmail ?? lockResult?.lockOwnerEmployeeId ?? '—'} ` +
          `(reason=${lockResult?.reason}) — RESUME_PROCESSED suppressed`,
      );
    }

    logger.info(
      `[resume-persist] ✅ emitted RESUME_PROCESSED · upload_id=${upload_id} ` +
        `candidate_id=${saveResult.candidate_id}`,
    );
    fileLogger.event('handler.done', {
      from: 'AO.resumeParser',
      to: '(handler return)',
      upload_id,
      candidate_id: saveResult.candidate_id,
      resume_id: saveResult.resume_id,
      application_id: saveResult.application_id,
      is_new_candidate: saveResult.candidate_created,
      is_new_resume: saveResult.resume_created,
      robohire_request_id: robohireRequestId,
    });

    return {
      ok: true,
      upload_id,
      candidate_id: saveResult.candidate_id,
      candidate_name: parsed.name ?? null,
      resume_id: saveResult.resume_id,
      application_id: saveResult.application_id,
      is_new_candidate: saveResult.candidate_created,
      is_new_resume: saveResult.resume_created,
    };
    }); // runWithLogger
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

// ADR-0040 — 把 RAAS 预填的 job_requisition_ids 规整成去重、去空白的 string[]。
// 容忍 undefined / 非数组 / 含空串 / 重复值,产出干净的 id 列表。
function normalizeJobRequisitionIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Unwrap RAAS-canonical envelope shape to flat fields.
 *
 * Envelope: { entity_id, entity_type, event_id, payload: {...}, trace }
 * Flat:     { bucket, objectKey, ... }
 */
function unwrapDownloadedEnvelope(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, any>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return {
      ...(r.payload as Record<string, any>),
      _envelope_entity_id: r.entity_id,
      _envelope_entity_type: r.entity_type,
      _envelope_event_id: r.event_id,
      _envelope_trace: r.trace,
    };
  }
  return r;
}

/**
 * 多种 shape 兼容地提取 RoboHire parsed.data:
 *   A) raw.parsed.data         — 标准 (RoboHire data spread under .parsed)
 *   B) raw.parsed              — RoboHire data 直接放在 .parsed
 *   C) raw.parsed_data         — snake_case 变体
 *   D) raw.parser.data         — 偶发的 .parser 包装
 */
function pickParsedData(raw: Record<string, any>): RaasParseResumeData | null {
  if (raw.parsed && typeof raw.parsed === 'object') {
    if (raw.parsed.data && typeof raw.parsed.data === 'object') {
      return raw.parsed.data as RaasParseResumeData;
    }
    // 直接是 parsed object 本身
    if (typeof raw.parsed.name === 'string' || Array.isArray(raw.parsed.experience)) {
      return raw.parsed as RaasParseResumeData;
    }
  }
  if (raw.parsed_data && typeof raw.parsed_data === 'object') {
    return raw.parsed_data as RaasParseResumeData;
  }
  if (raw.parser && typeof raw.parser === 'object' && raw.parser.data) {
    return raw.parser.data as RaasParseResumeData;
  }
  return null;
}

/** 提取 trace_id 给 RAAS API X-Trace-Id header 用 */
function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) {
    return t.trace_id;
  }
  return undefined;
}

/**
 * 给 step.run 用的 step key sanitizer — Inngest step key 只能是
 * [A-Za-z0-9-_], 上传 id 里的 UUID 自带连字符没问题, 但兜底兼容.
 */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'unknown';
}

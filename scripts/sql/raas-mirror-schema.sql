-- RAAS 本地镜像 schema(开发态读取兜底用)。
-- 由 raas_v4 的 prisma schema 经 `prisma migrate diff --from-empty` 生成,
-- 已**剥离全部外键约束**(AO 只写/读子集,不写 client/employee 等主表 →
-- 强制 FK 会让 write-only / 部分数据 INSERT 失败)。
-- 生成命令见 scripts/raas-mirror-up.ts;重生成请重跑 migrate diff 再剥 FK。
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "resume_upload_runtime" (
    "upload_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "job_requisition_id" TEXT,
    "recruiter_id" TEXT,
    "sourcing_channel_id" TEXT,
    "status" TEXT NOT NULL,
    "candidate_id" TEXT,
    "resume_id" TEXT,
    "application_id" TEXT,
    "error_message" TEXT,
    "external_resume_id" TEXT,
    "external_lock_state" TEXT,
    "external_locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_upload_runtime_pkey" PRIMARY KEY ("upload_id")
);

-- CreateTable
CREATE TABLE "requirement_runtime_state" (
    "job_requisition_id" TEXT NOT NULL,
    "analysis_status" TEXT,
    "workflow_status" TEXT,
    "jd_status" TEXT,
    "analysis_error_message" TEXT,
    "can_trigger_analysis" BOOLEAN NOT NULL DEFAULT true,
    "latest_task" JSONB,
    "latest_analysis" JSONB,
    "analysis_history" JSONB,
    "clarification_rounds" JSONB,
    "manual_override_history" JSONB,
    "latest_clarification_summary" JSONB,
    "parse_source" TEXT,
    "parse_confidence" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requirement_runtime_state_pkey" PRIMARY KEY ("job_requisition_id")
);

-- CreateTable
CREATE TABLE "candidate_runtime_state" (
    "candidate_id" TEXT NOT NULL,
    "resume_parse_status" TEXT,
    "ai_parse_confidence" DOUBLE PRECISION,
    "current_company" TEXT,
    "current_title" TEXT,
    "last_match_result" TEXT,
    "parse_error_message" TEXT,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "candidate_runtime_state_pkey" PRIMARY KEY ("candidate_id")
);

-- CreateTable
CREATE TABLE "event_outbox" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "source_action" TEXT,
    "topic" TEXT NOT NULL,
    "trace_id" TEXT,
    "request_id" TEXT,
    "workflow_id" TEXT,
    "parent_trace_id" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "trace_payload" JSONB,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_consumer_checkpoint" (
    "id" TEXT NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "trace_id" TEXT,
    "request_id" TEXT,
    "workflow_id" TEXT,
    "parent_trace_id" TEXT,
    "status" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_consumer_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_id" TEXT,
    "event_name" TEXT,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "action_url" TEXT,
    "action_label" TEXT,
    "extra_data" JSONB NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_module_config" (
    "id" TEXT NOT NULL,
    "module_key" TEXT NOT NULL,
    "module_name" TEXT NOT NULL,
    "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_module_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_message_log" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body_html" TEXT,
    "body_text" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_message_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_config" (
    "id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "api_base_url" TEXT,
    "base_prompt" TEXT NOT NULL DEFAULT '',
    "agent_class" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "input_price_per_1m" DOUBLE PRECISION,
    "output_price_per_1m" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ontology_object_catalog" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "is_latest" BOOLEAN NOT NULL DEFAULT false,
    "storage_policy" TEXT NOT NULL,
    "canonical_client_id" TEXT,
    "partition_year" INTEGER,
    "partition_month" INTEGER,
    "bucket_name" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "attribution_source" TEXT,
    "source_event_time" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "ontology_object_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_definition" (
    "definition_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "active_version_id" TEXT,
    "flow_import_snapshot" JSONB,
    "audit_log" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_definition_pkey" PRIMARY KEY ("definition_id")
);

-- CreateTable
CREATE TABLE "flow_version" (
    "version_id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "errors" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "unconsumed_events" JSONB NOT NULL,
    "is_draft" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "published_by" TEXT,

    CONSTRAINT "flow_version_pkey" PRIMARY KEY ("version_id")
);

-- CreateTable
CREATE TABLE "flow_instance" (
    "instance_id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "definition_name" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "primary_entity_type" TEXT NOT NULL,
    "primary_entity_id" TEXT NOT NULL,
    "trace" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "current_node_id" TEXT,
    "waiting_on_task_id" TEXT,
    "waiting_on_resume_token_id" TEXT,
    "node_runs" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_instance_pkey" PRIMARY KEY ("instance_id")
);

-- CreateTable
CREATE TABLE "flow_resume_token" (
    "resume_token_id" TEXT NOT NULL,
    "flow_instance_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "waiting_action" TEXT,
    "source_event" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "flow_resume_token_pkey" PRIMARY KEY ("resume_token_id")
);

-- CreateTable
CREATE TABLE "hitl_task" (
    "task_id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "flow_definition_id" TEXT,
    "flow_version_id" TEXT,
    "flow_instance_id" TEXT,
    "node_id" TEXT,
    "actor_kind" TEXT NOT NULL,
    "waiting_action" TEXT,
    "emit_events" JSONB NOT NULL,
    "form_schema_ref" JSONB,
    "form_schema" JSONB,
    "queue" TEXT,
    "owner_role" TEXT,
    "priority" TEXT NOT NULL,
    "assigned_to" TEXT,
    "source_event" TEXT,
    "related_entities" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "response_payload" JSONB,
    "transitions" JSONB NOT NULL,
    "cancel_reason" TEXT,
    "override_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "blocking_scope" TEXT,
    "stage_code" TEXT,
    "business_object_type" TEXT,
    "business_object_id" TEXT,
    "reason_code" TEXT,
    "ai_summary" TEXT,
    "evidence_refs" JSONB,
    "suggested_action" TEXT,
    "risk_note" TEXT,
    "assignee" TEXT,
    "sla_at" TIMESTAMP(3),
    "escalation_policy" TEXT,
    "recovery_events" JSONB,
    "idempotency_key" TEXT,
    "created_by_event_id" TEXT,
    "urgency_level" TEXT,
    "sla_remaining_seconds" INTEGER,
    "sla_threshold_warning" TIMESTAMP(3),
    "sla_threshold_critical" TIMESTAMP(3),
    "routing_reason" TEXT,
    "client_id" TEXT,
    "client_department_id" TEXT,
    "csi_department_id" TEXT,

    CONSTRAINT "hitl_task_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "task_mapping_rule" (
    "rule_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "owner_role" TEXT,
    "queue" TEXT,
    "severity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_mapping_rule_pkey" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "human_rule" (
    "rule_id" TEXT NOT NULL,
    "rule_code" TEXT NOT NULL,
    "version_id" TEXT,
    "version_no" INTEGER,
    "title" TEXT NOT NULL,
    "executor" TEXT NOT NULL DEFAULT 'Human',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scenario_key" TEXT,
    "customer_key" TEXT,
    "department_key" TEXT,
    "logic_description" TEXT,
    "execution_steps" TEXT,
    "remarks" TEXT,
    "trigger_event_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trigger_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trigger_ai_rule_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source_file" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "human_rule_pkey" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "flow_override_log" (
    "override_id" TEXT NOT NULL,
    "task_id" TEXT,
    "flow_instance_id" TEXT,
    "overridden_by" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_override_log_pkey" PRIMARY KEY ("override_id")
);

-- CreateTable
CREATE TABLE "flow_import_snapshot" (
    "snapshot_id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "workflow" JSONB NOT NULL,
    "node_overrides" JSONB NOT NULL,
    "editor_state" JSONB,
    "imported_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_import_snapshot_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateTable
CREATE TABLE "flow_publish_audit" (
    "audit_id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "version_id" TEXT,
    "version_no" INTEGER,
    "audit_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_publish_audit_pkey" PRIMARY KEY ("audit_id")
);

-- CreateTable
CREATE TABLE "storage_drift_scan" (
    "scan_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "triggered_by" TEXT,
    "summary" JSONB NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "storage_drift_scan_pkey" PRIMARY KEY ("scan_id")
);

-- CreateTable
CREATE TABLE "storage_drift_record" (
    "drift_id" TEXT NOT NULL,
    "scan_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "drift_kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "bucket_name" TEXT,
    "object_key" TEXT,
    "catalog_version_id" TEXT,
    "details" JSONB NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "acknowledged_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,

    CONSTRAINT "storage_drift_record_pkey" PRIMARY KEY ("drift_id")
);

-- CreateTable
CREATE TABLE "pii_access_audit" (
    "access_id" TEXT NOT NULL,
    "resource_kind" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "field_paths" JSONB NOT NULL,
    "access_mode" TEXT NOT NULL,
    "purpose" TEXT,
    "requested_by" TEXT,
    "requester_role" TEXT,
    "result" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pii_access_audit_pkey" PRIMARY KEY ("access_id")
);

-- CreateTable
CREATE TABLE "flow_export_audit" (
    "export_id" TEXT NOT NULL,
    "resource_kind" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "masking_mode" TEXT NOT NULL,
    "field_scope" JSONB NOT NULL,
    "requested_by" TEXT,
    "purpose" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_export_audit_pkey" PRIMARY KEY ("export_id")
);

-- CreateTable
CREATE TABLE "hitl_task_log" (
    "log_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "previous_status" TEXT,
    "new_status" TEXT NOT NULL,
    "payload" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hitl_task_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "runtime_log" (
    "log_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,
    "actor_name" TEXT,
    "business_object_type" TEXT,
    "business_object_id" TEXT,
    "stage_code" TEXT,
    "result_label" TEXT,
    "summary" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "hitl_task_id" TEXT,
    "next_action" TEXT,
    "trace_id" TEXT,
    "request_id" TEXT,
    "tenant_id" TEXT,

    CONSTRAINT "runtime_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "agent_explanation_log" (
    "log_id" TEXT NOT NULL,
    "trace_id" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_name" TEXT NOT NULL,
    "provider" TEXT,
    "model_name" TEXT,
    "latency_ms" INTEGER,
    "token_count" INTEGER,
    "confidence" DOUBLE PRECISION,
    "decision_label" TEXT,
    "reasoning_steps" JSONB,
    "rule_hits" JSONB,
    "confidence_breakdown" JSONB,
    "evidence_quotes" JSONB,
    "business_object_type" TEXT,
    "business_object_id" TEXT,
    "request_id" TEXT,
    "tenant_id" TEXT,

    CONSTRAINT "agent_explanation_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "agent_config" (
    "id" TEXT NOT NULL,
    "agent_key" TEXT,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '🤖',
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "description" TEXT,
    "implementation_status" TEXT NOT NULL DEFAULT 'not_started',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "supports_trigger" BOOLEAN NOT NULL DEFAULT false,
    "agent_name_patterns" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_heartbeat" (
    "agent_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "last_beat_at" TIMESTAMP(3) NOT NULL,
    "today_tasks" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "avg_latency_ms" INTEGER,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "current_error" TEXT,

    CONSTRAINT "agent_heartbeat_pkey" PRIMARY KEY ("agent_key")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "log_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operator_id" TEXT,
    "operator_name" TEXT,
    "operator_role" TEXT,
    "risk_level" TEXT,
    "action_label" TEXT NOT NULL,
    "object_type" TEXT,
    "object_id" TEXT,
    "object_label" TEXT,
    "summary" TEXT,
    "ip_address" TEXT,
    "source_label" TEXT,
    "diff_payload" JSONB,
    "reason" TEXT,
    "related_hitl_task_id" TEXT,
    "is_resume_event" BOOLEAN NOT NULL DEFAULT false,
    "tenant_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "import_batch" (
    "batch_id" VARCHAR(64) NOT NULL,
    "import_type" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "uploaded_by" VARCHAR(64),
    "uploaded_by_name" VARCHAR(128),
    "file_name" VARCHAR(256),
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "success_rows" INTEGER NOT NULL DEFAULT 0,
    "updated_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "tenant_id" VARCHAR(64),

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("batch_id")
);

-- CreateTable
CREATE TABLE "recommendation_material_change_log" (
    "change_log_id" TEXT NOT NULL,
    "recommendation_material_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "change_type" TEXT NOT NULL,
    "change_summary" TEXT,
    "changed_fields" JSONB,
    "operator_id" TEXT,
    "operator_name" TEXT,
    "audit_log_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_material_change_log_pkey" PRIMARY KEY ("change_log_id")
);

-- CreateTable
CREATE TABLE "candidate_match_result_runtime_state" (
    "candidate_match_result_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "job_posting_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "education_score" DECIMAL(65,30),
    "skills_score" DECIMAL(65,30),
    "project_experience_score" DECIMAL(65,30),
    "stability_score" DECIMAL(65,30),
    "experience_score" DECIMAL(65,30),
    "experience_assessment" TEXT,
    "total_weighted_score" DECIMAL(65,30),
    "matched_skills" JSONB,
    "missing_skills" JSONB,
    "must_have_analysis" JSONB,
    "nice_to_have_analysis" JSONB,
    "star_rating" INTEGER,
    "qualification_retained" BOOLEAN,
    "advantages" JSONB NOT NULL DEFAULT '[]',
    "disadvantages" JSONB NOT NULL DEFAULT '[]',
    "ai_summary" TEXT,
    "final_recommendation" TEXT,
    "raw_llm_response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_match_result_runtime_state_pkey" PRIMARY KEY ("candidate_match_result_id")
);

-- CreateTable
CREATE TABLE "interview_invitation" (
    "interview_invitation_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "candidate_match_result_id" TEXT,
    "scheduled_start_at" TIMESTAMP(3) NOT NULL,
    "scheduled_end_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 30,
    "interview_type" TEXT NOT NULL DEFAULT 'ai_interview',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "interviewer_employee_id" TEXT,
    "meeting_link" TEXT,
    "mock_interview_result" TEXT,
    "mock_tech_score" DECIMAL(65,30),
    "mock_notes" TEXT,
    "mock_submitted_at" TIMESTAMP(3),
    "mock_submitted_by" TEXT,
    "interview_mode" TEXT,
    "meeting_code" TEXT,
    "interview_location" TEXT,
    "abandon_reason" TEXT,
    "abandoned_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "correlation_id" TEXT,
    "trigger_source" TEXT,
    "resume_id" TEXT,
    "job_posting_id" TEXT,
    "recruiter_id" TEXT,
    "recruiter_email" TEXT,
    "candidate_email" TEXT,
    "interview_language" TEXT DEFAULT 'zh',
    "interviewer_requirement" TEXT,
    "passing_score" INTEGER,
    "linked_assessment_id" TEXT,
    "hiring_request_id" TEXT,
    "login_url" TEXT,
    "qrcode_url" TEXT,
    "gohire_user_id" TEXT,
    "request_introduction_id" TEXT,
    "gohire_invite_log" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "requested_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),

    CONSTRAINT "interview_invitation_pkey" PRIMARY KEY ("interview_invitation_id")
);

-- CreateTable
CREATE TABLE "interview_follow_up" (
    "interview_follow_up_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "interview_invitation_id" TEXT,
    "interview_round" TEXT,
    "actual_interview_time" TIMESTAMP(3),
    "client_interviewer_name" TEXT,
    "interview_questions" TEXT,
    "candidate_feedback" TEXT,
    "candidate_interest_level" TEXT,
    "follow_up_result" TEXT,
    "follow_up_by" TEXT,
    "follow_up_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_follow_up_pkey" PRIMARY KEY ("interview_follow_up_id")
);

-- CreateTable
CREATE TABLE "requirement_clarification_record" (
    "id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "clarified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" TEXT NOT NULL,
    "clarifier_name" TEXT,
    "client_clarifier_name" TEXT,
    "clarification_type" TEXT,
    "attachments" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_clarification_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_requisition_specification" (
    "job_requisition_specification_id" TEXT NOT NULL,
    "hro_service_contract_id" TEXT,
    "client_id" TEXT,
    "start_date" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "create_time" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "create_by" TEXT,
    "sd_org_name" TEXT,
    "hsm_employee_id" TEXT,
    "recruiter_employee_id" TEXT,
    "assigned_hsm_name" TEXT,
    "assigned_recruiter_name" TEXT,
    "priority" TEXT,
    "is_exclusive" BOOLEAN,
    "number_of_competitors" INTEGER,
    "status" TEXT,
    "close_reason" TEXT,
    "completion_time" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_requisition_specification_pkey" PRIMARY KEY ("job_requisition_specification_id")
);

-- CreateTable
CREATE TABLE "job_requisition" (
    "job_requisition_id" TEXT NOT NULL,
    "job_requisition_specification_id" TEXT,
    "csi_department_id" TEXT,
    "client_department_id" TEXT,
    "client_id" TEXT,
    "standard_job_role_id" TEXT,
    "evaluation_model_id" TEXT,
    "client_job_id" TEXT,
    "client_job_temp_id" TEXT,
    "client_job_title" TEXT,
    "client_job_type" TEXT,
    "job_responsibility" TEXT,
    "job_requirement" TEXT,
    "job_type" TEXT,
    "recruitment_type" TEXT,
    "work_years" INTEGER,
    "gender" TEXT,
    "age_range" TEXT,
    "degree_requirement" TEXT,
    "education_requirement" TEXT,
    "city" TEXT,
    "city_id" UUID,
    "work_address" JSONB,
    "salary_range" TEXT,
    "must_have_skills" JSONB,
    "nice_to_have_skills" JSONB,
    "requirement_keywords" JSONB,
    "language_requirements" TEXT,
    "negative_requirement" TEXT,
    "qualifications" TEXT,
    "hard_requirements" TEXT,
    "nice_to_have" TEXT,
    "interview_requirements" TEXT,
    "evaluation_rules" TEXT,
    "benefits" TEXT,
    "headcount" INTEGER,
    "recruit_target" INTEGER,
    "joined_staff" INTEGER,
    "competitor_application_count" INTEGER NOT NULL DEFAULT 0,
    "hc_status" TEXT,
    "fill_difficulty" TEXT,
    "urgency_level" TEXT,
    "open_date" TIMESTAMP(3),
    "required_arrival_date" TIMESTAMP(3),
    "work_schedule_type" TEXT,
    "require_foreigner" BOOLEAN,
    "clarify_questions" JSONB,
    "recruitment_strategies" TEXT,
    "interview_mode" TEXT,
    "interview_process" TEXT,
    "first_interviewer_name" TEXT,
    "final_interviewer_name" TEXT,
    "first_interview_format" TEXT,
    "final_interview_format" TEXT,
    "expected_level" TEXT,
    "client_contact_name" TEXT,
    "demand_type" TEXT,
    "client_published_at" TIMESTAMP(3),
    "client_updated_at" TIMESTAMP(3),
    "oa_department" TEXT,
    "service_bg" TEXT,
    "business_pm_name" TEXT,
    "interviewer_names_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_requisition_pkey" PRIMARY KEY ("job_requisition_id")
);

-- CreateTable
CREATE TABLE "requirement_claim" (
    "id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "recruiter_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_by" TEXT NOT NULL,
    "released_at" TIMESTAMP(3),
    "released_by" TEXT,

    CONSTRAINT "requirement_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_mapping" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_department_id" TEXT,
    "csi_department_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_default_csi_department" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "csi_department_id" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_default_csi_department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule" (
    "rule_id" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "threshold_value" DOUBLE PRECISION NOT NULL,
    "threshold_unit" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "notification_targets" JSONB,
    "escalation_strategy" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tenant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rule_pkey" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "id" TEXT NOT NULL,
    "config_key" TEXT NOT NULL,
    "config_value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_requirement" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "client_department_id" TEXT,
    "req_id" TEXT NOT NULL,
    "city" TEXT,
    "req_name" TEXT,
    "job_type" TEXT,
    "contact" TEXT,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "priority" TEXT,
    "publish_date" TIMESTAMP(3),
    "close_date" TIMESTAMP(3),
    "expected_date" TIMESTAMP(3),
    "onboarded" INTEGER NOT NULL DEFAULT 0,
    "pending_onboard" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT,
    "resume_control" TEXT,
    "expected_level" TEXT,
    "salary_range" TEXT,
    "work_address" TEXT,
    "recruitment_type" TEXT,
    "interview_mode" TEXT,
    "interviewer_names" JSONB,
    "business_pm" TEXT,
    "oa_department" TEXT,
    "assigned_hsm" TEXT,
    "assigned_recruiter" TEXT,
    "job_responsibility" TEXT,
    "job_requirement" TEXT,
    "degree_requirement" TEXT,
    "work_years" INTEGER,
    "service_bg" TEXT,
    "in_process_count" INTEGER NOT NULL DEFAULT 0,
    "close_time" TIMESTAMP(3),
    "open_date" TIMESTAMP(3),
    "required_arrival_date" TIMESTAMP(3),

    CONSTRAINT "client_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application" (
    "application_id" TEXT NOT NULL,
    "client_id" TEXT,
    "job_requisition_id" TEXT NOT NULL,
    "candidate_id" TEXT,
    "resume_id" TEXT,
    "recruiter_employee_id" TEXT,
    "status" TEXT,
    "stage" TEXT,
    "matching_score" INTEGER,
    "process_sla" TIMESTAMP(3),
    "push_timestamp" TIMESTAMP(3),
    "duplicate_check_result" TEXT,
    "original_level" TEXT,
    "supplier_suggested_level" TEXT,
    "negotiated_level" TEXT,
    "compliance_credential" TEXT,
    "approved_onboard_date" TIMESTAMP(3),
    "actual_onboard_date" TIMESTAMP(3),
    "sla_deadline" TIMESTAMP(3),
    "portfolio_attachment" TEXT,
    "notes" TEXT,
    "has_referral_bonus" BOOLEAN,
    "rejection_reason" TEXT,
    "abandon_reason" TEXT,
    "next_followup_employee_id" TEXT,
    "client_onboard_date" TIMESTAMP(3),
    "import_batch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_pkey" PRIMARY KEY ("application_id")
);

-- CreateTable
CREATE TABLE "integration_api_key" (
    "key_id" TEXT NOT NULL,
    "caller_name" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scope" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "integration_api_key_pkey" PRIMARY KEY ("key_id")
);

-- CreateTable
CREATE TABLE "analytics_report" (
    "report_id" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "overall_health" TEXT NOT NULL,
    "report_data" JSONB NOT NULL,

    CONSTRAINT "analytics_report_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "job_requisition_attachment" (
    "attachment_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "attachment_type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "content_type" TEXT,
    "size_bytes" BIGINT,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_requisition_attachment_pkey" PRIMARY KEY ("attachment_id")
);

-- CreateTable
CREATE TABLE "written_test_record" (
    "written_test_record_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3),
    "assigned_by" TEXT,
    "recovery_deadline_days" INTEGER,
    "recovered_at" TIMESTAMP(3),
    "submitted_to_client_at" TIMESTAMP(3),
    "result" TEXT,
    "notes" TEXT,
    "follow_up_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "written_test_record_pkey" PRIMARY KEY ("written_test_record_id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "user_session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "login_at" TIMESTAMP(3) NOT NULL,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL,
    "logout_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("user_session_id")
);

-- CreateTable
CREATE TABLE "user_activity_event" (
    "user_activity_event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "user_activity_event_pkey" PRIMARY KEY ("user_activity_event_id")
);

-- CreateTable
CREATE TABLE "employee" (
    "employee_id" TEXT NOT NULL,
    "csi_department_id" TEXT,
    "name" TEXT NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "job_title" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "shift_time" TEXT,
    "supervisor_employee_id" TEXT,
    "password_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approval_status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approval_note" TEXT,
    "bound_client_id" TEXT,
    "bound_client_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auto_claim_scope_pairs" JSONB,
    "permissions" JSONB,
    "sd_org_name" TEXT,
    "last_login_at" TIMESTAMP(3),
    "theme_mode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "wecom_user_id" TEXT,
    "feishu_user_id" TEXT,
    "dingtalk_user_id" TEXT,
    "welink_user_id" TEXT,
    "im_sync_status" JSONB,

    CONSTRAINT "employee_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "employee_client_scope" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_department_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_client_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "client_id" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "address" TEXT,
    "industry_category" TEXT,
    "submission_materials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entry_day_rules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "technical_stack_preference" TEXT,
    "job_grade_rate_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "welfare_policy" TEXT,
    "total_competitors" INTEGER,
    "compliance_policy" TEXT,
    "resume_template" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "client_preference_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "client_department_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stakeholder_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hro_service_contract_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "client_rms_system_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entrance_management_system_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "client_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "client_department" (
    "client_department_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "dept_name" TEXT NOT NULL,
    "description" TEXT,
    "head_name" TEXT,
    "head_contact" TEXT,
    "specific_hiring_rules" TEXT,
    "red_line_policy" TEXT,
    "entrance_management_system_id" TEXT,
    "client_rms_system_id" TEXT,
    "preferences" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_department_pkey" PRIMARY KEY ("client_department_id")
);

-- CreateTable
CREATE TABLE "client_preference" (
    "client_preference_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "target_role_category" TEXT,
    "preference_type" TEXT,
    "likes" TEXT,
    "dislikes" TEXT,
    "preferred_industry" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excluded_industry" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gap_tolerance_threshold" TEXT,
    "excluded_education_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resignation_cooling_months" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_preference_pkey" PRIMARY KEY ("client_preference_id")
);

-- CreateTable
CREATE TABLE "client_department_preference" (
    "client_department_preference_id" TEXT NOT NULL,
    "client_department_id" TEXT NOT NULL,
    "preference_type" TEXT,
    "likes" TEXT,
    "dislikes" TEXT,
    "priority_weight" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_department_preference_pkey" PRIMARY KEY ("client_department_preference_id")
);

-- CreateTable
CREATE TABLE "stakeholder" (
    "stakeholder_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_department_id" TEXT,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "contact_info" TEXT,
    "decision_weight" TEXT,
    "feedback_speed" DOUBLE PRECISION,
    "stakeholder_preference_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stakeholder_pkey" PRIMARY KEY ("stakeholder_id")
);

-- CreateTable
CREATE TABLE "stakeholder_preference" (
    "stakeholder_preference_id" TEXT NOT NULL,
    "stakeholder_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "preference_type" TEXT,
    "likes" TEXT,
    "dislikes" TEXT,
    "priority_weight" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stakeholder_preference_pkey" PRIMARY KEY ("stakeholder_preference_id")
);

-- CreateTable
CREATE TABLE "hro_service_contract" (
    "hro_service_contract_id" TEXT NOT NULL,
    "contract_full_name" TEXT NOT NULL,
    "contract_short_name" TEXT,
    "effective_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "month_standard_days" INTEGER,
    "day_standard_hours" INTEGER,
    "settlement_mode" TEXT,
    "settlement_cycle" TEXT,
    "client_id" TEXT NOT NULL,
    "hro_service_provider_id" TEXT,
    "overtime_rhythm" TEXT,
    "overtime_payment_rule" TEXT,
    "bonus_rules" TEXT,
    "authorized_job_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "job_grade_rate_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hro_service_contract_pkey" PRIMARY KEY ("hro_service_contract_id")
);

-- CreateTable
CREATE TABLE "hro_service_provider" (
    "hro_service_provider_id" TEXT NOT NULL,
    "registered_full_name" TEXT NOT NULL,
    "registered_cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "service_regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "service_industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "core_competencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tech_stack_expertise" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hro_service_provider_pkey" PRIMARY KEY ("hro_service_provider_id")
);

-- CreateTable
CREATE TABLE "standard_job_role" (
    "standard_job_role_id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "sequence" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level_scope" TEXT,
    "description" TEXT,
    "description_examples" TEXT,
    "refresh_note" TEXT,
    "leveling_matrix" TEXT,
    "evaluation_model_id" TEXT,
    "base_salary_band_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "standard_job_role_pkey" PRIMARY KEY ("standard_job_role_id")
);

-- CreateTable
CREATE TABLE "job_grade_rate" (
    "job_grade_rate_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "job_name" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "job_grade" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "job_city" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shore_type" TEXT,
    "grade_description" TEXT,
    "unit_price_wtax" DOUBLE PRECISION,
    "billing_unit" TEXT,
    "effective_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "remarks" TEXT,
    "hro_service_contract_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_grade_rate_pkey" PRIMARY KEY ("job_grade_rate_id")
);

-- CreateTable
CREATE TABLE "client_rms_system" (
    "client_rms_system_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_department_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "requisition_entry_mode" TEXT,
    "required_requisition_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approval_flow_description" TEXT,
    "status_mapping_rules" TEXT,
    "access_url" TEXT,
    "credential_type" TEXT,
    "credentials" TEXT,
    "api_endpoint" TEXT,
    "integration_protocol" TEXT,
    "sync_frequency" TEXT,
    "contact_person" TEXT,
    "contact_info" TEXT,
    "status" TEXT NOT NULL DEFAULT '待上线',
    "version" TEXT,
    "notes" TEXT,
    "field_mapping_config" TEXT,
    "sync_logs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_rms_system_pkey" PRIMARY KEY ("client_rms_system_id")
);

-- CreateTable
CREATE TABLE "entrance_management_system" (
    "entrance_management_system_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_department_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "process_scope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required_document_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pre_entry_checks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schedule_rule" TEXT,
    "entry_location_list" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "access_card_process_rule" TEXT,
    "entrance_status_mapping_rule" TEXT,
    "access_url" TEXT,
    "credential_type" TEXT,
    "credentials" TEXT,
    "api_endpoint" TEXT,
    "integration_protocol" TEXT,
    "contact_person" TEXT,
    "contact_info" TEXT,
    "status" TEXT NOT NULL DEFAULT '待上线',
    "version" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entrance_management_system_pkey" PRIMARY KEY ("entrance_management_system_id")
);

-- CreateTable
CREATE TABLE "csi_department" (
    "csi_department_id" TEXT NOT NULL,
    "hro_service_provider_id" TEXT,
    "dept_name" TEXT NOT NULL,
    "description" TEXT,
    "head_name" TEXT,
    "head_contact" TEXT,
    "specific_hiring_rules" TEXT,
    "red_line_policy" TEXT,
    "superior_department_id" TEXT,
    "dept_type" TEXT DEFAULT 'delivery',
    "head_employee_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "csi_department_pkey" PRIMARY KEY ("csi_department_id")
);

-- CreateTable
CREATE TABLE "candidate" (
    "candidate_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "gender" TEXT,
    "birth_date" TIMESTAMP(3),
    "current_location" TEXT,
    "highest_acquired_degree" TEXT,
    "graduation_school" TEXT,
    "work_years" INTEGER,
    "current_company" TEXT,
    "current_title" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "certificates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "id_card_number_hash" TEXT,
    "recommend_score" DOUBLE PRECISION,
    "blacklist_status" BOOLEAN NOT NULL DEFAULT false,
    "data_source" TEXT,
    "latest_resume_id" TEXT,
    "candidate_expectation_id" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ai_interview_score" DOUBLE PRECISION,
    "background_check_status" TEXT,
    "sourcing_channel_id" TEXT,
    "referrer_employee_id" TEXT,
    "preferred_target_industry" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferred_target_role_category" TEXT,
    "last_contact_at" TIMESTAMP(3),
    "willing_to_redirect" TEXT,
    "willing_to_redirect_note" TEXT,
    "status" TEXT,
    "state" TEXT,
    "state_group" TEXT,
    "employee_id" TEXT,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "lock_start_time" TIMESTAMP(3),
    "mobile_normalized" TEXT,
    "needs_mobile_review" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_pkey" PRIMARY KEY ("candidate_id")
);

-- CreateTable
CREATE TABLE "candidate_expectation" (
    "candidate_expectation_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "expected_position" TEXT,
    "expected_location" TEXT,
    "expected_salary_range" TEXT,
    "outsourcing_acceptance_level" TEXT,
    "expected_industry" TEXT,
    "expected_company_size" TEXT,
    "constraints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expected_work_mode" TEXT,
    "available_from" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_expectation_pkey" PRIMARY KEY ("candidate_expectation_id")
);

-- CreateTable
CREATE TABLE "candidate_match_result" (
    "candidate_match_result_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "match_score" DOUBLE PRECISION,
    "match_reason" TEXT,
    "match_status" TEXT,
    "job_posting_id" TEXT,
    "rank" INTEGER,
    "dimension_scores" JSONB,
    "core_tags" JSONB NOT NULL DEFAULT '[]',
    "experience_years" DECIMAL(65,30),
    "stage" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_match_result_pkey" PRIMARY KEY ("candidate_match_result_id")
);

-- CreateTable
CREATE TABLE "candidate_match_feedback" (
    "candidate_match_feedback_id" TEXT NOT NULL,
    "candidate_match_result_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "job_posting_id" TEXT,
    "resume_id" TEXT,
    "verdict" TEXT NOT NULL,
    "reason_tags" JSONB NOT NULL DEFAULT '[]',
    "comment" TEXT,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_match_feedback_pkey" PRIMARY KEY ("candidate_match_feedback_id")
);

-- CreateTable
CREATE TABLE "project_staff_exit_feedback" (
    "project_staff_exit_feedback_id" TEXT NOT NULL,
    "roster_id" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "inference_type" TEXT NOT NULL DEFAULT 'release_idle',
    "inferred_value" BOOLEAN NOT NULL,
    "verdict" TEXT NOT NULL,
    "comment" TEXT,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_staff_exit_feedback_pkey" PRIMARY KEY ("project_staff_exit_feedback_id")
);

-- CreateTable
CREATE TABLE "resume" (
    "resume_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "file_name" TEXT,
    "file_type" TEXT,
    "file_size" INTEGER,
    "original_file_url" TEXT,
    "parsed_content" TEXT,
    "parsed_content_version" INTEGER,
    "raw_parse_result" JSONB,
    "summary" TEXT,
    "skills_extracted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "work_history" JSONB,
    "education_history" JSONB,
    "project_history" JSONB,
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parse_status" TEXT,
    "parse_error" TEXT,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3),
    "effective_date" TIMESTAMP(3),
    "awards" JSONB,
    "certifications_detail" JSONB,
    "languages_detail" JSONB,
    "skills_detail" JSONB,
    "bucket_name" TEXT,
    "object_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_pkey" PRIMARY KEY ("resume_id")
);

-- CreateTable
CREATE TABLE "job_posting" (
    "job_posting_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "posting_title" TEXT NOT NULL,
    "posting_description" TEXT,
    "posting_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "external_url" TEXT,
    "hiring_manager_id" TEXT,
    "recruiter_id" TEXT,
    "headcount" INTEGER,
    "urgency_level" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "city" TEXT,
    "salary_range_monthly_min" INTEGER,
    "salary_range_monthly_max" INTEGER,
    "salary_range" TEXT,
    "salary_currency" TEXT,
    "salary_period" TEXT,
    "degree_requirement" TEXT,
    "interview_mode" TEXT,
    "required_arrival_date" TIMESTAMP(3),
    "search_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publish_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_posting_pkey" PRIMARY KEY ("job_posting_id")
);

-- CreateTable
CREATE TABLE "job_posting_recruiter_lifecycle" (
    "id" TEXT NOT NULL,
    "job_posting_id" TEXT NOT NULL,
    "recruiter_id" TEXT NOT NULL,
    "publish_status" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "channels" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_posting_recruiter_lifecycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_report" (
    "evaluation_report_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "application_id" TEXT,
    "overall_score" DOUBLE PRECISION,
    "overall_status" TEXT,
    "summary" TEXT,
    "tech_score" DOUBLE PRECISION,
    "communication_score" DOUBLE PRECISION,
    "culture_fit_score" DOUBLE PRECISION,
    "interview_record_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evaluation_report_pkey" PRIMARY KEY ("evaluation_report_id")
);

-- CreateTable
CREATE TABLE "interview_record" (
    "interview_record_id" TEXT NOT NULL,
    "interview_model_id" TEXT,
    "application_id" TEXT,
    "interviewer_employee_id" TEXT,
    "interview_type" TEXT,
    "interview_round" TEXT,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "duration_minutes" INTEGER,
    "interview_mode" TEXT,
    "recording_url" TEXT,
    "raw_interview_notes" TEXT,
    "candidate_behavior_notes" TEXT,
    "tech_gaps_identified" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "golden_30_call_status" BOOLEAN,
    "interview_result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_record_pkey" PRIMARY KEY ("interview_record_id")
);

-- CreateTable
CREATE TABLE "recommendation_material" (
    "recommendation_material_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "job_requisition_id" TEXT,
    "material_url" TEXT,
    "material_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendation_material_pkey" PRIMARY KEY ("recommendation_material_id")
);

-- CreateTable
CREATE TABLE "job_offer" (
    "job_offer_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "application_id" TEXT,
    "client_id" TEXT,
    "salary_scheme_id" TEXT,
    "hro_service_provider_id" TEXT,
    "offered_department" TEXT,
    "offered_job_title" TEXT,
    "work_location" TEXT,
    "contract_start_date" TIMESTAMP(3),
    "contract_duration_years" INTEGER,
    "probation_period_months" INTEGER,
    "onboarding_deadline_datetime" TIMESTAMP(3),
    "reporting_address" TEXT,
    "response_deadline_days" INTEGER,
    "offer_version_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "address_to_date" TIMESTAMP(3),
    "reject_reason" TEXT,
    "disapproval_reason" TEXT,
    "special_approval" TEXT,
    "created_by_employee_id" TEXT,
    "approved_by_employee_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_offer_pkey" PRIMARY KEY ("job_offer_id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "approval_request_id" TEXT NOT NULL,
    "approval_type" TEXT NOT NULL,
    "object_type" TEXT,
    "object_id" TEXT,
    "submitted_by" TEXT,
    "submitted_at" TIMESTAMP(3),
    "decision" TEXT,
    "decision_by" TEXT,
    "decision_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "priority_level" TEXT,
    "sla_deadline" TIMESTAMP(3),
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("approval_request_id")
);

-- CreateTable
CREATE TABLE "city_dict" (
    "city_id" UUID NOT NULL,
    "province" TEXT,
    "city_name" TEXT NOT NULL,
    "code" TEXT,
    "pinyin" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "merged_into" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "city_dict_pkey" PRIMARY KEY ("city_id")
);

-- CreateTable
CREATE TABLE "city_alias" (
    "alias" TEXT NOT NULL,
    "city_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_alias_pkey" PRIMARY KEY ("alias")
);

-- CreateTable
CREATE TABLE "city_alias_pending" (
    "id" UUID NOT NULL,
    "raw_text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_ref" TEXT,
    "suggested_city_id" UUID,
    "suggested_match_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "handled_by" TEXT,
    "handled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_alias_pending_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourcing_channel" (
    "sourcing_channel_id" TEXT NOT NULL,
    "channel_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_channel_pkey" PRIMARY KEY ("sourcing_channel_id")
);

-- CreateTable
CREATE TABLE "candidate_tag" (
    "candidate_tag_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "tag_name" TEXT NOT NULL,
    "tag_color" TEXT,
    "created_by_employee_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_tag_pkey" PRIMARY KEY ("candidate_tag_id")
);

-- CreateTable
CREATE TABLE "candidate_note" (
    "candidate_note_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "note_text" TEXT NOT NULL,
    "created_by_employee_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_note_pkey" PRIMARY KEY ("candidate_note_id")
);

-- CreateTable
CREATE TABLE "external_api_call_log" (
    "call_id" TEXT NOT NULL,
    "external_system" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "request_summary" JSONB NOT NULL,
    "response_summary" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "caller_source" TEXT NOT NULL,
    "caller_upload_id" TEXT,
    "caller_operator_id" TEXT,
    "caller_trace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_api_call_log_pkey" PRIMARY KEY ("call_id")
);

-- CreateTable
CREATE TABLE "blacklist" (
    "blacklist_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "client_id" TEXT,
    "client_department_id" TEXT,
    "job_requisition_id" TEXT,
    "lock_reason" TEXT,
    "lock_duration_months" INTEGER,
    "expires_at" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "source_metadata" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blacklist_pkey" PRIMARY KEY ("blacklist_id")
);

-- CreateTable
CREATE TABLE "token_billing_sku_registry" (
    "sku_code" TEXT NOT NULL,
    "display_name_zh" TEXT NOT NULL,
    "display_name_en" TEXT NOT NULL,
    "trigger_source_actions" JSONB NOT NULL,
    "default_human_replaced_action" TEXT NOT NULL,
    "default_human_replaced_minutes" INTEGER NOT NULL,
    "default_human_role_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_billing_sku_registry_pkey" PRIMARY KEY ("sku_code")
);

-- CreateTable
CREATE TABLE "token_billing_sku_pricing" (
    "id" TEXT NOT NULL,
    "sku_code" TEXT NOT NULL,
    "pricing_per_call_cny" DECIMAL(10,4) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "configured_by_employee_id" TEXT,
    "status" TEXT NOT NULL,
    "approval_request_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_billing_sku_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_labor_rate_config" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "human_role_key" TEXT NOT NULL,
    "rate_per_hour_cny" DECIMAL(10,2) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "configured_by_type" TEXT NOT NULL,
    "configured_by_id" TEXT NOT NULL,
    "source_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_labor_rate_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_billing_call_view" (
    "trace_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "sku_code" TEXT,
    "source_action" TEXT NOT NULL,
    "agent_name" TEXT,
    "module" TEXT,
    "client_id" TEXT,
    "job_requisition_id" TEXT,
    "candidate_id" TEXT,
    "employee_id" TEXT,
    "provider" TEXT,
    "model_name" TEXT,
    "token_input" INTEGER NOT NULL DEFAULT 0,
    "token_output" INTEGER NOT NULL DEFAULT 0,
    "token_total" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "cost_cny" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "pricing_per_call_cny" DECIMAL(10,4),
    "elapsed_ms" INTEGER,
    "status" TEXT NOT NULL,
    "human_replaced_minutes" INTEGER,
    "human_role_key" TEXT,
    "human_replaced_cost_cny" DECIMAL(10,4),
    "roi_multiple" DECIMAL(8,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_billing_call_view_pkey" PRIMARY KEY ("trace_id")
);

-- CreateTable
CREATE TABLE "token_billing_monthly_view" (
    "id" TEXT NOT NULL,
    "period_yyyymm" TEXT NOT NULL,
    "client_id" TEXT,
    "sku_code" TEXT NOT NULL,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "call_count_success" INTEGER NOT NULL DEFAULT 0,
    "token_total" INTEGER NOT NULL DEFAULT 0,
    "cost_total_cny" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "billable_total_cny" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "human_replaced_minutes" INTEGER NOT NULL DEFAULT 0,
    "human_replaced_cost_cny" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "net_savings_cny" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "roi_multiple" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "anomaly_flag" BOOLEAN NOT NULL DEFAULT false,
    "prev_period_roi" DECIMAL(8,2),
    "recomputed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_billing_monthly_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_posting_auto_invitation_config" (
    "id" UUID NOT NULL,
    "job_posting_id" TEXT NOT NULL,
    "recruiter_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "score_threshold" INTEGER NOT NULL DEFAULT 85,
    "memo_hard_requirements" TEXT,
    "daily_cap_per_jd" INTEGER NOT NULL DEFAULT 10,
    "cancel_window_minutes" INTEGER NOT NULL DEFAULT 30,
    "send_window_start" TEXT NOT NULL DEFAULT '09:00',
    "send_window_end" TEXT NOT NULL DEFAULT '20:00',
    "send_days_of_week" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "dedupe_window_days" INTEGER NOT NULL DEFAULT 7,
    "notify_owner_mode" TEXT NOT NULL DEFAULT 'per_event',
    "client_id" TEXT NOT NULL,
    "client_department_id" TEXT,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_posting_auto_invitation_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_invitation_attempt" (
    "id" UUID NOT NULL,
    "job_posting_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "application_id" TEXT,
    "match_score" INTEGER,
    "decision" TEXT NOT NULL,
    "send_source" TEXT NOT NULL DEFAULT 'auto',
    "skip_reason" TEXT,
    "scheduled_send_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "interview_invitation_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_department_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_invitation_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hrbp_department_scope" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "csi_department_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hrbp_department_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_delivery_scope" (
    "id" TEXT NOT NULL,
    "recruiting_csi_department_id" TEXT NOT NULL,
    "delivery_csi_department_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recruiting_delivery_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boss_recruiter_daily_metrics" (
    "id" TEXT NOT NULL,
    "stat_date" DATE NOT NULL,
    "boss_name" TEXT NOT NULL,
    "phone_masked" TEXT,
    "company" TEXT,
    "group_name" TEXT,
    "certified_title" TEXT,
    "enterprise_email" TEXT,
    "boss_view_talent" INTEGER NOT NULL DEFAULT 0,
    "boss_initiate_chat" INTEGER NOT NULL DEFAULT 0,
    "boss_communicate" INTEGER NOT NULL DEFAULT 0,
    "talent_view_boss" INTEGER NOT NULL DEFAULT 0,
    "talent_initiate_chat" INTEGER NOT NULL DEFAULT 0,
    "resume_received" INTEGER NOT NULL DEFAULT 0,
    "contact_exchanged" INTEGER NOT NULL DEFAULT 0,
    "interview_accepted" INTEGER NOT NULL DEFAULT 0,
    "employee_id" TEXT,
    "import_batch_id" TEXT NOT NULL,
    "imported_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boss_recruiter_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_staff_roster" (
    "id" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hire_date" DATE,
    "dept_supervisor" TEXT,
    "business_unit_raw" TEXT NOT NULL,
    "business_unit_csi_id" TEXT,
    "risk_level" TEXT NOT NULL,
    "idle_type" TEXT NOT NULL,
    "idle_reason" TEXT NOT NULL,
    "current_status" TEXT NOT NULL,
    "std_job_role_id" TEXT,
    "job_family_raw" TEXT,
    "job_group_raw" TEXT,
    "job_sequence_raw" TEXT,
    "job_position_raw" TEXT,
    "expected_exit_date" DATE,
    "actual_exit_date" DATE,
    "expected_coordination_date" DATE,
    "roster_exit_date" DATE,
    "investment_exit_date" DATE,
    "investment_release_idle" BOOLEAN NOT NULL DEFAULT false,
    "last_import_batch_id" TEXT NOT NULL,
    "last_imported_at" TIMESTAMP(3) NOT NULL,
    "last_imported_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_staff_roster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_staff_status_change_log" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_by_id" TEXT,
    "change_source" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_staff_status_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_staff_ai_profile" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "level" TEXT,
    "experience_years" INTEGER,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "strength" TEXT,
    "confidence" INTEGER,
    "disposition" TEXT,
    "ai_note" TEXT,
    "push_status" TEXT NOT NULL DEFAULT 'none',
    "pushed_at" TIMESTAMP(3),
    "pushed_by_id" TEXT,
    "match_count_gte80" INTEGER NOT NULL DEFAULT 0,
    "llm_enriched" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3),
    "compute_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_staff_ai_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_staff_match" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "job_requisition_id" TEXT NOT NULL,
    "job_requisition_specification_id" TEXT,
    "score" INTEGER NOT NULL,
    "rank" INTEGER,
    "match_reason" TEXT,
    "requirement_name" TEXT,
    "client_id" TEXT,
    "client_name" TEXT,
    "hsm_employee_id" TEXT,
    "hsm_name" TEXT,
    "csi_department_id" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_staff_match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_staff_investment" (
    "id" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dept_path" TEXT,
    "project_code" TEXT NOT NULL,
    "project_name" TEXT NOT NULL,
    "project_dept" TEXT,
    "project_type" TEXT,
    "project_start" DATE,
    "project_end" DATE,
    "raw_count" INTEGER NOT NULL,
    "merged_count" INTEGER NOT NULL,
    "segments" JSONB NOT NULL,
    "latest_end" DATE,
    "last_import_batch_id" TEXT NOT NULL,
    "last_imported_at" TIMESTAMP(3) NOT NULL,
    "last_imported_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_staff_investment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_staff_archive" (
    "id" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "birth_date" DATE,
    "main_skill" TEXT,
    "edu_level" TEXT,
    "study_mode" TEXT,
    "school" TEXT,
    "school_type" TEXT,
    "major" TEXT,
    "grad_date" DATE,
    "company_grade" TEXT,
    "job_level" TEXT,
    "job_seq" TEXT,
    "base_job" TEXT,
    "post" TEXT,
    "is_backbone" BOOLEAN NOT NULL DEFAULT false,
    "is_cadre" BOOLEAN NOT NULL DEFAULT false,
    "cert_level" TEXT,
    "client_job_class" TEXT,
    "client_level" TEXT,
    "org_group" TEXT,
    "org_biz_group" TEXT,
    "org_biz_line" TEXT,
    "org_bu" TEXT,
    "org_delivery_dept" TEXT,
    "entry_date" DATE,
    "tenure_years" DOUBLE PRECISION,
    "work_since" DATE,
    "it_since" DATE,
    "staff_status" TEXT,
    "work_location" TEXT,
    "mgmt_location" TEXT,
    "contract_type" TEXT,
    "contract_end" DATE,
    "legal_entity" TEXT,
    "prev_company" TEXT,
    "last_import_batch_id" TEXT NOT NULL,
    "last_imported_at" TIMESTAMP(3) NOT NULL,
    "last_imported_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_staff_archive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resume_upload_runtime_status_idx" ON "resume_upload_runtime"("status");

-- CreateIndex
CREATE INDEX "resume_upload_runtime_job_requisition_id_idx" ON "resume_upload_runtime"("job_requisition_id");

-- CreateIndex
CREATE INDEX "resume_upload_runtime_candidate_id_idx" ON "resume_upload_runtime"("candidate_id");

-- CreateIndex
CREATE INDEX "requirement_runtime_state_analysis_status_idx" ON "requirement_runtime_state"("analysis_status");

-- CreateIndex
CREATE INDEX "requirement_runtime_state_workflow_status_idx" ON "requirement_runtime_state"("workflow_status");

-- CreateIndex
CREATE INDEX "requirement_runtime_state_jd_status_idx" ON "requirement_runtime_state"("jd_status");

-- CreateIndex
CREATE INDEX "candidate_runtime_state_resume_parse_status_idx" ON "candidate_runtime_state"("resume_parse_status");

-- CreateIndex
CREATE UNIQUE INDEX "event_outbox_event_id_key" ON "event_outbox"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_outbox_idempotency_key_key" ON "event_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "event_outbox_event_name_idx" ON "event_outbox"("event_name");

-- CreateIndex
CREATE INDEX "event_outbox_trace_id_idx" ON "event_outbox"("trace_id");

-- CreateIndex
CREATE INDEX "event_outbox_request_id_idx" ON "event_outbox"("request_id");

-- CreateIndex
CREATE INDEX "event_outbox_workflow_id_idx" ON "event_outbox"("workflow_id");

-- CreateIndex
CREATE INDEX "event_outbox_entity_type_entity_id_idx" ON "event_outbox"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "event_outbox_status_idx" ON "event_outbox"("status");

-- CreateIndex
CREATE INDEX "event_outbox_next_retry_at_idx" ON "event_outbox"("next_retry_at");

-- CreateIndex
CREATE INDEX "event_consumer_checkpoint_consumer_name_idx" ON "event_consumer_checkpoint"("consumer_name");

-- CreateIndex
CREATE INDEX "event_consumer_checkpoint_event_id_idx" ON "event_consumer_checkpoint"("event_id");

-- CreateIndex
CREATE INDEX "event_consumer_checkpoint_trace_id_idx" ON "event_consumer_checkpoint"("trace_id");

-- CreateIndex
CREATE INDEX "event_consumer_checkpoint_request_id_idx" ON "event_consumer_checkpoint"("request_id");

-- CreateIndex
CREATE INDEX "event_consumer_checkpoint_status_idx" ON "event_consumer_checkpoint"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_event_consumer_idempotency" ON "event_consumer_checkpoint"("consumer_name", "idempotency_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_event_id_idx" ON "notifications"("event_id");

-- CreateIndex
CREATE INDEX "notifications_event_name_idx" ON "notifications"("event_name");

-- CreateIndex
CREATE INDEX "notifications_category_idx" ON "notifications"("category");

-- CreateIndex
CREATE INDEX "notifications_severity_idx" ON "notifications"("severity");

-- CreateIndex
CREATE INDEX "notifications_is_read_idx" ON "notifications"("is_read");

-- CreateIndex
CREATE UNIQUE INDEX "uq_notifications_user_event" ON "notifications"("user_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_module_config_module_key_key" ON "notification_module_config"("module_key");

-- CreateIndex
CREATE INDEX "notification_module_config_module_key_idx" ON "notification_module_config"("module_key");

-- CreateIndex
CREATE INDEX "outbound_message_log_channel_idx" ON "outbound_message_log"("channel");

-- CreateIndex
CREATE INDEX "outbound_message_log_recipient_idx" ON "outbound_message_log"("recipient");

-- CreateIndex
CREATE INDEX "outbound_message_log_status_idx" ON "outbound_message_log"("status");

-- CreateIndex
CREATE INDEX "outbound_message_log_created_at_idx" ON "outbound_message_log"("created_at");

-- CreateIndex
CREATE INDEX "ai_model_config_scope_type_is_active_idx" ON "ai_model_config"("scope_type", "is_active");

-- CreateIndex
CREATE INDEX "idx_ontology_object_catalog_lookup" ON "ontology_object_catalog"("entity_type", "entity_id", "is_latest");

-- CreateIndex
CREATE INDEX "idx_ontology_object_catalog_list_latest" ON "ontology_object_catalog"("entity_type", "is_latest");

-- CreateIndex
CREATE INDEX "idx_ontology_object_catalog_client" ON "ontology_object_catalog"("canonical_client_id");

-- CreateIndex
CREATE INDEX "idx_ontology_object_catalog_partition" ON "ontology_object_catalog"("partition_year", "partition_month");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ontology_object_catalog_version" ON "ontology_object_catalog"("entity_type", "entity_id", "version_id");

-- CreateIndex
CREATE INDEX "idx_flow_definition_key" ON "flow_definition"("key");

-- CreateIndex
CREATE INDEX "idx_flow_definition_status" ON "flow_definition"("status");

-- CreateIndex
CREATE INDEX "idx_flow_version_definition" ON "flow_version"("definition_id");

-- CreateIndex
CREATE INDEX "idx_flow_version_definition_draft" ON "flow_version"("definition_id", "is_draft");

-- CreateIndex
CREATE UNIQUE INDEX "uq_flow_version_definition_version" ON "flow_version"("definition_id", "version_no", "is_draft");

-- CreateIndex
CREATE INDEX "idx_flow_instance_status" ON "flow_instance"("status");

-- CreateIndex
CREATE INDEX "idx_flow_instance_entity" ON "flow_instance"("primary_entity_type", "primary_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_flow_instance_identity" ON "flow_instance"("definition_id", "version_id", "primary_entity_id");

-- CreateIndex
CREATE INDEX "idx_flow_resume_token_instance" ON "flow_resume_token"("flow_instance_id");

-- CreateIndex
CREATE INDEX "idx_flow_resume_token_status" ON "flow_resume_token"("status");

-- CreateIndex
CREATE UNIQUE INDEX "idx_hitl_task_idempotency_key" ON "hitl_task"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_hitl_task_status" ON "hitl_task"("status");

-- CreateIndex
CREATE INDEX "idx_hitl_task_type" ON "hitl_task"("task_type");

-- CreateIndex
CREATE INDEX "idx_hitl_task_instance" ON "hitl_task"("flow_instance_id");

-- CreateIndex
CREATE INDEX "idx_hitl_task_queue" ON "hitl_task"("queue");

-- CreateIndex
CREATE INDEX "idx_hitl_task_blocking_scope" ON "hitl_task"("blocking_scope");

-- CreateIndex
CREATE INDEX "idx_hitl_task_biz_object" ON "hitl_task"("business_object_type", "business_object_id");

-- CreateIndex
CREATE INDEX "idx_hitl_task_urgency" ON "hitl_task"("urgency_level");

-- CreateIndex
CREATE INDEX "idx_hitl_task_sla_at" ON "hitl_task"("sla_at");

-- CreateIndex
CREATE INDEX "idx_hitl_task_assignee" ON "hitl_task"("assignee");

-- CreateIndex
CREATE INDEX "idx_hitl_task_csi_dept" ON "hitl_task"("csi_department_id");

-- CreateIndex
CREATE INDEX "idx_hitl_task_client_csi_dept" ON "hitl_task"("client_id", "csi_department_id");

-- CreateIndex
CREATE INDEX "idx_task_mapping_rule_event" ON "task_mapping_rule"("event_name");

-- CreateIndex
CREATE INDEX "idx_task_mapping_rule_active" ON "task_mapping_rule"("active");

-- CreateIndex
CREATE UNIQUE INDEX "human_rule_code_key" ON "human_rule"("rule_code");

-- CreateIndex
CREATE INDEX "idx_human_rule_scenario" ON "human_rule"("scenario_key");

-- CreateIndex
CREATE INDEX "idx_human_rule_customer" ON "human_rule"("customer_key");

-- CreateIndex
CREATE INDEX "idx_human_rule_status" ON "human_rule"("status");

-- CreateIndex
CREATE INDEX "idx_human_rule_active" ON "human_rule"("is_active");

-- CreateIndex
CREATE INDEX "idx_flow_override_log_task" ON "flow_override_log"("task_id");

-- CreateIndex
CREATE INDEX "idx_flow_override_log_instance" ON "flow_override_log"("flow_instance_id");

-- CreateIndex
CREATE INDEX "idx_flow_import_snapshot_definition" ON "flow_import_snapshot"("definition_id", "imported_at");

-- CreateIndex
CREATE INDEX "idx_flow_publish_audit_definition" ON "flow_publish_audit"("definition_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_storage_drift_scan_status" ON "storage_drift_scan"("status");

-- CreateIndex
CREATE INDEX "idx_storage_drift_scan_started" ON "storage_drift_scan"("started_at");

-- CreateIndex
CREATE INDEX "idx_storage_drift_record_scan" ON "storage_drift_record"("scan_id");

-- CreateIndex
CREATE INDEX "idx_storage_drift_record_status" ON "storage_drift_record"("status");

-- CreateIndex
CREATE INDEX "idx_storage_drift_record_kind" ON "storage_drift_record"("drift_kind");

-- CreateIndex
CREATE INDEX "idx_storage_drift_record_entity" ON "storage_drift_record"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idx_pii_access_audit_resource" ON "pii_access_audit"("resource_kind", "resource_id");

-- CreateIndex
CREATE INDEX "idx_pii_access_audit_mode" ON "pii_access_audit"("access_mode");

-- CreateIndex
CREATE INDEX "idx_pii_access_audit_requester" ON "pii_access_audit"("requested_by");

-- CreateIndex
CREATE INDEX "idx_pii_access_audit_created" ON "pii_access_audit"("created_at");

-- CreateIndex
CREATE INDEX "idx_flow_export_audit_resource" ON "flow_export_audit"("resource_kind", "resource_id");

-- CreateIndex
CREATE INDEX "idx_flow_export_audit_masking" ON "flow_export_audit"("masking_mode");

-- CreateIndex
CREATE INDEX "idx_flow_export_audit_requester" ON "flow_export_audit"("requested_by");

-- CreateIndex
CREATE INDEX "idx_flow_export_audit_created" ON "flow_export_audit"("created_at");

-- CreateIndex
CREATE INDEX "idx_hitl_task_log_task" ON "hitl_task_log"("task_id");

-- CreateIndex
CREATE INDEX "idx_hitl_task_log_created" ON "hitl_task_log"("created_at");

-- CreateIndex
CREATE INDEX "idx_runtime_log_biz_object" ON "runtime_log"("business_object_type", "business_object_id");

-- CreateIndex
CREATE INDEX "idx_runtime_log_stage" ON "runtime_log"("stage_code");

-- CreateIndex
CREATE INDEX "idx_runtime_log_trace" ON "runtime_log"("trace_id");

-- CreateIndex
CREATE INDEX "idx_runtime_log_timestamp" ON "runtime_log"("timestamp");

-- CreateIndex
CREATE INDEX "idx_runtime_log_result" ON "runtime_log"("result_label");

-- CreateIndex
CREATE INDEX "idx_agent_explanation_log_trace" ON "agent_explanation_log"("trace_id");

-- CreateIndex
CREATE INDEX "idx_agent_explanation_log_agent" ON "agent_explanation_log"("agent_name");

-- CreateIndex
CREATE INDEX "idx_agent_explanation_log_timestamp" ON "agent_explanation_log"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "agent_config_agent_key_key" ON "agent_config"("agent_key");

-- CreateIndex
CREATE INDEX "idx_audit_log_operator" ON "audit_log"("operator_id");

-- CreateIndex
CREATE INDEX "idx_audit_log_action" ON "audit_log"("action_label");

-- CreateIndex
CREATE INDEX "idx_audit_log_risk" ON "audit_log"("risk_level");

-- CreateIndex
CREATE INDEX "idx_audit_log_timestamp" ON "audit_log"("timestamp");

-- CreateIndex
CREATE INDEX "idx_audit_log_object" ON "audit_log"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "import_batch_started_at_idx" ON "import_batch"("started_at" DESC);

-- CreateIndex
CREATE INDEX "import_batch_import_type_started_at_idx" ON "import_batch"("import_type", "started_at" DESC);

-- CreateIndex
CREATE INDEX "import_batch_uploaded_by_started_at_idx" ON "import_batch"("uploaded_by", "started_at" DESC);

-- CreateIndex
CREATE INDEX "idx_rec_material_change_log_material_time" ON "recommendation_material_change_log"("recommendation_material_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_rec_material_change_log_type" ON "recommendation_material_change_log"("change_type");

-- CreateIndex
CREATE INDEX "idx_cmrrs_candidate_req" ON "candidate_match_result_runtime_state"("candidate_id", "job_requisition_id");

-- CreateIndex
CREATE INDEX "idx_cmrrs_client_score" ON "candidate_match_result_runtime_state"("client_id", "total_weighted_score");

-- CreateIndex
CREATE INDEX "idx_cmrrs_candidate" ON "candidate_match_result_runtime_state"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_invitation_correlation_id_key" ON "interview_invitation"("correlation_id");

-- CreateIndex
CREATE INDEX "idx_interview_invitation_slot_status" ON "interview_invitation"("scheduled_start_at", "status");

-- CreateIndex
CREATE INDEX "idx_interview_invitation_candidate" ON "interview_invitation"("candidate_id");

-- CreateIndex
CREATE INDEX "idx_interview_invitation_application" ON "interview_invitation"("application_id");

-- CreateIndex
CREATE INDEX "idx_interview_invitation_correlation" ON "interview_invitation"("correlation_id");

-- CreateIndex
CREATE INDEX "interview_follow_up_application_id_idx" ON "interview_follow_up"("application_id");

-- CreateIndex
CREATE INDEX "interview_follow_up_invitation_id_idx" ON "interview_follow_up"("interview_invitation_id");

-- CreateIndex
CREATE INDEX "interview_follow_up_follow_up_by_idx" ON "interview_follow_up"("follow_up_by");

-- CreateIndex
CREATE INDEX "requirement_clarification_record_job_requisition_id_idx" ON "requirement_clarification_record"("job_requisition_id");

-- CreateIndex
CREATE INDEX "requirement_clarification_record_job_requisition_id_clarifi_idx" ON "requirement_clarification_record"("job_requisition_id", "clarified_at");

-- CreateIndex
CREATE INDEX "job_requisition_specification_client_id_idx" ON "job_requisition_specification"("client_id");

-- CreateIndex
CREATE INDEX "job_requisition_specification_hro_service_contract_id_idx" ON "job_requisition_specification"("hro_service_contract_id");

-- CreateIndex
CREATE INDEX "job_requisition_specification_hsm_employee_id_idx" ON "job_requisition_specification"("hsm_employee_id");

-- CreateIndex
CREATE INDEX "job_requisition_specification_recruiter_employee_id_idx" ON "job_requisition_specification"("recruiter_employee_id");

-- CreateIndex
CREATE INDEX "job_requisition_specification_assigned_hsm_name_idx" ON "job_requisition_specification"("assigned_hsm_name");

-- CreateIndex
CREATE INDEX "job_requisition_specification_assigned_recruiter_name_idx" ON "job_requisition_specification"("assigned_recruiter_name");

-- CreateIndex
CREATE INDEX "job_requisition_specification_status_idx" ON "job_requisition_specification"("status");

-- CreateIndex
CREATE INDEX "job_requisition_job_requisition_specification_id_idx" ON "job_requisition"("job_requisition_specification_id");

-- CreateIndex
CREATE INDEX "job_requisition_csi_department_id_idx" ON "job_requisition"("csi_department_id");

-- CreateIndex
CREATE INDEX "job_requisition_client_department_id_idx" ON "job_requisition"("client_department_id");

-- CreateIndex
CREATE INDEX "job_requisition_standard_job_role_id_idx" ON "job_requisition"("standard_job_role_id");

-- CreateIndex
CREATE INDEX "job_requisition_client_job_id_idx" ON "job_requisition"("client_job_id");

-- CreateIndex
CREATE INDEX "job_requisition_client_job_type_idx" ON "job_requisition"("client_job_type");

-- CreateIndex
CREATE INDEX "job_requisition_job_type_idx" ON "job_requisition"("job_type");

-- CreateIndex
CREATE INDEX "job_requisition_city_idx" ON "job_requisition"("city");

-- CreateIndex
CREATE INDEX "job_requisition_city_id_idx" ON "job_requisition"("city_id");

-- CreateIndex
CREATE INDEX "job_requisition_service_bg_idx" ON "job_requisition"("service_bg");

-- CreateIndex
CREATE INDEX "job_requisition_client_published_at_idx" ON "job_requisition"("client_published_at");

-- CreateIndex
CREATE INDEX "job_requisition_updated_at_idx" ON "job_requisition"("updated_at");

-- CreateIndex
CREATE INDEX "job_requisition_client_id_idx" ON "job_requisition"("client_id");

-- CreateIndex
CREATE INDEX "idx_jreq_spec_scope" ON "job_requisition"("job_requisition_specification_id", "client_id", "client_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_jreq_client_dept_jobid" ON "job_requisition"("client_id", "client_department_id", "client_job_id");

-- CreateIndex
CREATE INDEX "requirement_claim_job_requisition_id_released_at_idx" ON "requirement_claim"("job_requisition_id", "released_at");

-- CreateIndex
CREATE INDEX "requirement_claim_recruiter_id_released_at_idx" ON "requirement_claim"("recruiter_id", "released_at");

-- CreateIndex
CREATE INDEX "idx_dept_mapping_lookup" ON "department_mapping"("client_id", "client_department_id", "is_active");

-- CreateIndex
CREATE INDEX "idx_dept_mapping_csi_dept" ON "department_mapping"("csi_department_id");

-- CreateIndex
CREATE INDEX "idx_client_default_csi_dept" ON "client_default_csi_department"("csi_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_client_default_csi_pair" ON "client_default_csi_department"("client_id", "csi_department_id");

-- CreateIndex
CREATE INDEX "idx_alert_rule_type" ON "alert_rule"("alert_type");

-- CreateIndex
CREATE INDEX "idx_alert_rule_active" ON "alert_rule"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_config_key_key" ON "system_config"("config_key");

-- CreateIndex
CREATE INDEX "client_requirement_req_id_idx" ON "client_requirement"("req_id");

-- CreateIndex
CREATE INDEX "client_requirement_job_type_idx" ON "client_requirement"("job_type");

-- CreateIndex
CREATE INDEX "client_requirement_city_idx" ON "client_requirement"("city");

-- CreateIndex
CREATE INDEX "client_requirement_client_id_idx" ON "client_requirement"("client_id");

-- CreateIndex
CREATE INDEX "client_requirement_client_id_client_department_id_idx" ON "client_requirement"("client_id", "client_department_id");

-- CreateIndex
CREATE INDEX "application_job_requisition_id_idx" ON "application"("job_requisition_id");

-- CreateIndex
CREATE INDEX "application_candidate_id_idx" ON "application"("candidate_id");

-- CreateIndex
CREATE INDEX "application_client_id_idx" ON "application"("client_id");

-- CreateIndex
CREATE INDEX "application_import_batch_id_idx" ON "application"("import_batch_id");

-- CreateIndex
CREATE INDEX "application_next_followup_idx" ON "application"("next_followup_employee_id");

-- CreateIndex
CREATE INDEX "integration_api_key_enabled_idx" ON "integration_api_key"("enabled");

-- CreateIndex
CREATE INDEX "analytics_report_generated_at_idx" ON "analytics_report"("generated_at");

-- CreateIndex
CREATE INDEX "analytics_report_period_idx" ON "analytics_report"("period");

-- CreateIndex
CREATE INDEX "job_requisition_attachment_jr_idx" ON "job_requisition_attachment"("job_requisition_id");

-- CreateIndex
CREATE INDEX "job_requisition_attachment_uploaded_by_idx" ON "job_requisition_attachment"("uploaded_by");

-- CreateIndex
CREATE INDEX "job_requisition_attachment_type_idx" ON "job_requisition_attachment"("attachment_type");

-- CreateIndex
CREATE INDEX "written_test_record_application_id_idx" ON "written_test_record"("application_id");

-- CreateIndex
CREATE INDEX "written_test_record_follow_up_by_idx" ON "written_test_record"("follow_up_by");

-- CreateIndex
CREATE INDEX "user_session_user_date_idx" ON "user_session"("user_id", "login_at");

-- CreateIndex
CREATE INDEX "user_activity_event_user_date_idx" ON "user_activity_event"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "user_activity_event_type_idx" ON "user_activity_event"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "employee_email_key" ON "employee"("email");

-- CreateIndex
CREATE UNIQUE INDEX "employee_wecom_user_id_key" ON "employee"("wecom_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_feishu_user_id_key" ON "employee"("feishu_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_dingtalk_user_id_key" ON "employee"("dingtalk_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_welink_user_id_key" ON "employee"("welink_user_id");

-- CreateIndex
CREATE INDEX "employee_status_idx" ON "employee"("status");

-- CreateIndex
CREATE INDEX "employee_csi_department_id_idx" ON "employee"("csi_department_id");

-- CreateIndex
CREATE INDEX "employee_supervisor_employee_id_idx" ON "employee"("supervisor_employee_id");

-- CreateIndex
CREATE INDEX "idx_employee_client_scope_employee" ON "employee_client_scope"("employee_id");

-- CreateIndex
CREATE INDEX "idx_employee_client_scope_client_dept" ON "employee_client_scope"("client_id", "client_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_employee_client_scope_triple" ON "employee_client_scope"("employee_id", "client_id", "client_department_id");

-- CreateIndex
CREATE INDEX "client_status_idx" ON "client"("status");

-- CreateIndex
CREATE INDEX "client_client_name_idx" ON "client"("client_name");

-- CreateIndex
CREATE INDEX "client_industry_category_idx" ON "client"("industry_category");

-- CreateIndex
CREATE INDEX "client_department_client_id_idx" ON "client_department"("client_id");

-- CreateIndex
CREATE INDEX "client_preference_client_id_idx" ON "client_preference"("client_id");

-- CreateIndex
CREATE INDEX "client_department_preference_dept_id_idx" ON "client_department_preference"("client_department_id");

-- CreateIndex
CREATE INDEX "stakeholder_client_id_idx" ON "stakeholder"("client_id");

-- CreateIndex
CREATE INDEX "stakeholder_client_department_id_idx" ON "stakeholder"("client_department_id");

-- CreateIndex
CREATE INDEX "stakeholder_preference_stakeholder_id_idx" ON "stakeholder_preference"("stakeholder_id");

-- CreateIndex
CREATE INDEX "stakeholder_preference_client_id_idx" ON "stakeholder_preference"("client_id");

-- CreateIndex
CREATE INDEX "hro_service_contract_client_id_idx" ON "hro_service_contract"("client_id");

-- CreateIndex
CREATE INDEX "hro_service_provider_status_idx" ON "hro_service_provider"("status");

-- CreateIndex
CREATE INDEX "standard_job_role_family_idx" ON "standard_job_role"("family");

-- CreateIndex
CREATE INDEX "standard_job_role_group_idx" ON "standard_job_role"("group");

-- CreateIndex
CREATE INDEX "standard_job_role_sequence_idx" ON "standard_job_role"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "standard_job_role_natural_uniq" ON "standard_job_role"("family", "group", "sequence", "name");

-- CreateIndex
CREATE INDEX "job_grade_rate_client_id_idx" ON "job_grade_rate"("client_id");

-- CreateIndex
CREATE INDEX "job_grade_rate_contract_id_idx" ON "job_grade_rate"("hro_service_contract_id");

-- CreateIndex
CREATE INDEX "client_rms_system_client_id_idx" ON "client_rms_system"("client_id");

-- CreateIndex
CREATE INDEX "entrance_management_system_client_id_idx" ON "entrance_management_system"("client_id");

-- CreateIndex
CREATE INDEX "csi_department_superior_dept_idx" ON "csi_department"("superior_department_id");

-- CreateIndex
CREATE INDEX "csi_department_provider_idx" ON "csi_department"("hro_service_provider_id");

-- CreateIndex
CREATE INDEX "csi_department_head_employee_idx" ON "csi_department"("head_employee_id");

-- CreateIndex
CREATE INDEX "candidate_name_idx" ON "candidate"("name");

-- CreateIndex
CREATE INDEX "candidate_dedup_idx" ON "candidate"("mobile_normalized", "name");

-- CreateIndex
CREATE INDEX "candidate_mobile_idx" ON "candidate"("mobile");

-- CreateIndex
CREATE INDEX "candidate_sourcing_idx" ON "candidate"("sourcing_channel_id");

-- CreateIndex
CREATE INDEX "candidate_status_idx" ON "candidate"("status");

-- CreateIndex
CREATE INDEX "candidate_employee_id_idx" ON "candidate"("employee_id");

-- CreateIndex
CREATE INDEX "candidate_state_idx" ON "candidate"("state");

-- CreateIndex
CREATE INDEX "candidate_state_group_idx" ON "candidate"("state_group");

-- CreateIndex
CREATE INDEX "candidate_expectation_candidate_id_idx" ON "candidate_expectation"("candidate_id");

-- CreateIndex
CREATE INDEX "candidate_match_result_candidate_id_idx" ON "candidate_match_result"("candidate_id");

-- CreateIndex
CREATE INDEX "candidate_match_result_jr_id_idx" ON "candidate_match_result"("job_requisition_id");

-- CreateIndex
CREATE INDEX "candidate_match_result_posting_score_idx" ON "candidate_match_result"("job_posting_id", "match_score" DESC);

-- CreateIndex
CREATE INDEX "candidate_match_result_jr_rank_idx" ON "candidate_match_result"("job_requisition_id", "rank");

-- CreateIndex
CREATE INDEX "candidate_match_feedback_result_id_idx" ON "candidate_match_feedback"("candidate_match_result_id");

-- CreateIndex
CREATE INDEX "candidate_match_feedback_jr_id_idx" ON "candidate_match_feedback"("job_requisition_id");

-- CreateIndex
CREATE INDEX "candidate_match_feedback_candidate_id_idx" ON "candidate_match_feedback"("candidate_id");

-- CreateIndex
CREATE INDEX "candidate_match_feedback_submitter_idx" ON "candidate_match_feedback"("submitted_by");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_match_feedback_result_submitter_uniq" ON "candidate_match_feedback"("candidate_match_result_id", "submitted_by");

-- CreateIndex
CREATE INDEX "project_staff_exit_feedback_roster_idx" ON "project_staff_exit_feedback"("roster_id");

-- CreateIndex
CREATE INDEX "project_staff_exit_feedback_emp_idx" ON "project_staff_exit_feedback"("employee_code");

-- CreateIndex
CREATE INDEX "project_staff_exit_feedback_submitter_idx" ON "project_staff_exit_feedback"("submitted_by");

-- CreateIndex
CREATE UNIQUE INDEX "project_staff_exit_feedback_uniq" ON "project_staff_exit_feedback"("roster_id", "inference_type", "submitted_by");

-- CreateIndex
CREATE INDEX "resume_candidate_id_idx" ON "resume"("candidate_id");

-- CreateIndex
CREATE INDEX "job_posting_jr_id_idx" ON "job_posting"("job_requisition_id");

-- CreateIndex
CREATE INDEX "job_posting_client_id_idx" ON "job_posting"("client_id");

-- CreateIndex
CREATE INDEX "job_posting_status_idx" ON "job_posting"("status");

-- CreateIndex
CREATE INDEX "job_posting_publish_status_idx" ON "job_posting"("publish_status");

-- CreateIndex
CREATE INDEX "jp_recruiter_lifecycle_recruiter_status_idx" ON "job_posting_recruiter_lifecycle"("recruiter_id", "publish_status");

-- CreateIndex
CREATE INDEX "jp_recruiter_lifecycle_jp_id_idx" ON "job_posting_recruiter_lifecycle"("job_posting_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_jp_recruiter_lifecycle" ON "job_posting_recruiter_lifecycle"("job_posting_id", "recruiter_id");

-- CreateIndex
CREATE INDEX "evaluation_report_candidate_id_idx" ON "evaluation_report"("candidate_id");

-- CreateIndex
CREATE INDEX "evaluation_report_jr_id_idx" ON "evaluation_report"("job_requisition_id");

-- CreateIndex
CREATE INDEX "evaluation_report_application_id_idx" ON "evaluation_report"("application_id");

-- CreateIndex
CREATE INDEX "interview_record_application_id_idx" ON "interview_record"("application_id");

-- CreateIndex
CREATE INDEX "interview_record_start_time_idx" ON "interview_record"("start_time");

-- CreateIndex
CREATE INDEX "recommendation_material_candidate_id_idx" ON "recommendation_material"("candidate_id");

-- CreateIndex
CREATE INDEX "job_offer_application_id_idx" ON "job_offer"("application_id");

-- CreateIndex
CREATE INDEX "job_offer_candidate_id_idx" ON "job_offer"("candidate_id");

-- CreateIndex
CREATE INDEX "job_offer_job_requisition_id_idx" ON "job_offer"("job_requisition_id");

-- CreateIndex
CREATE INDEX "job_offer_client_id_idx" ON "job_offer"("client_id");

-- CreateIndex
CREATE INDEX "job_offer_status_idx" ON "job_offer"("status");

-- CreateIndex
CREATE INDEX "approval_request_status_idx" ON "approval_request"("status");

-- CreateIndex
CREATE INDEX "approval_request_object_type_idx" ON "approval_request"("object_type");

-- CreateIndex
CREATE UNIQUE INDEX "city_dict_code_key" ON "city_dict"("code");

-- CreateIndex
CREATE INDEX "city_dict_is_active_sort_order_idx" ON "city_dict"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "city_dict_province_idx" ON "city_dict"("province");

-- CreateIndex
CREATE UNIQUE INDEX "city_dict_city_name_province_key" ON "city_dict"("city_name", "province");

-- CreateIndex
CREATE INDEX "city_alias_city_id_idx" ON "city_alias"("city_id");

-- CreateIndex
CREATE INDEX "city_alias_pending_status_created_at_idx" ON "city_alias_pending"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "city_alias_pending_raw_text_source_source_ref_key" ON "city_alias_pending"("raw_text", "source", "source_ref");

-- CreateIndex
CREATE INDEX "sourcing_channel_is_active_sort_order_idx" ON "sourcing_channel"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "candidate_tag_candidate_id_idx" ON "candidate_tag"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_tag_unique_per_candidate" ON "candidate_tag"("candidate_id", "tag_name");

-- CreateIndex
CREATE INDEX "candidate_note_candidate_id_idx" ON "candidate_note"("candidate_id");

-- CreateIndex
CREATE INDEX "candidate_note_candidate_created_idx" ON "candidate_note"("candidate_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "external_api_call_log_external_system_endpoint_created_at_idx" ON "external_api_call_log"("external_system", "endpoint", "created_at");

-- CreateIndex
CREATE INDEX "external_api_call_log_caller_operator_id_created_at_idx" ON "external_api_call_log"("caller_operator_id", "created_at");

-- CreateIndex
CREATE INDEX "external_api_call_log_status_created_at_idx" ON "external_api_call_log"("status", "created_at");

-- CreateIndex
CREATE INDEX "blacklist_candidate_id_active_idx" ON "blacklist"("candidate_id", "active");

-- CreateIndex
CREATE INDEX "blacklist_candidate_id_client_id_active_idx" ON "blacklist"("candidate_id", "client_id", "active");

-- CreateIndex
CREATE INDEX "blacklist_source_created_at_idx" ON "blacklist"("source", "created_at");

-- CreateIndex
CREATE INDEX "idx_sku_pricing_active" ON "token_billing_sku_pricing"("sku_code", "status");

-- CreateIndex
CREATE INDEX "idx_sku_pricing_period" ON "token_billing_sku_pricing"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "token_billing_sku_pricing_sku_code_effective_from_key" ON "token_billing_sku_pricing"("sku_code", "effective_from");

-- CreateIndex
CREATE INDEX "idx_labor_rate_client" ON "client_labor_rate_config"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_labor_rate_config_client_id_human_role_key_effective_key" ON "client_labor_rate_config"("client_id", "human_role_key", "effective_from");

-- CreateIndex
CREATE INDEX "idx_billing_call_sku_time" ON "token_billing_call_view"("sku_code", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_billing_call_client_time" ON "token_billing_call_view"("client_id", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_billing_call_jr" ON "token_billing_call_view"("job_requisition_id");

-- CreateIndex
CREATE INDEX "idx_billing_call_candidate" ON "token_billing_call_view"("candidate_id");

-- CreateIndex
CREATE INDEX "idx_billing_call_time" ON "token_billing_call_view"("occurred_at");

-- CreateIndex
CREATE INDEX "idx_billing_monthly_period" ON "token_billing_monthly_view"("period_yyyymm");

-- CreateIndex
CREATE INDEX "idx_billing_monthly_client" ON "token_billing_monthly_view"("client_id", "period_yyyymm");

-- CreateIndex
CREATE INDEX "idx_billing_monthly_sku" ON "token_billing_monthly_view"("sku_code", "period_yyyymm");

-- CreateIndex
CREATE UNIQUE INDEX "token_billing_monthly_view_period_yyyymm_client_id_sku_code_key" ON "token_billing_monthly_view"("period_yyyymm", "client_id", "sku_code");

-- CreateIndex
CREATE INDEX "idx_auto_invitation_config_jd" ON "job_posting_auto_invitation_config"("job_posting_id");

-- CreateIndex
CREATE INDEX "idx_auto_invitation_config_recruiter" ON "job_posting_auto_invitation_config"("recruiter_id");

-- CreateIndex
CREATE INDEX "idx_auto_invitation_config_scope" ON "job_posting_auto_invitation_config"("client_id", "client_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_auto_invitation_config_jd_recruiter" ON "job_posting_auto_invitation_config"("job_posting_id", "recruiter_id");

-- CreateIndex
CREATE UNIQUE INDEX "auto_invitation_attempt_idempotency_key_key" ON "auto_invitation_attempt"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_auto_invitation_attempt_candidate" ON "auto_invitation_attempt"("candidate_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_auto_invitation_attempt_jd_decision" ON "auto_invitation_attempt"("job_posting_id", "decision", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_auto_invitation_attempt_pending_sweep" ON "auto_invitation_attempt"("decision", "scheduled_send_at");

-- CreateIndex
CREATE INDEX "idx_auto_invitation_attempt_scope" ON "auto_invitation_attempt"("client_id", "client_department_id");

-- CreateIndex
CREATE INDEX "idx_hrbp_scope_employee" ON "hrbp_department_scope"("employee_id");

-- CreateIndex
CREATE INDEX "idx_hrbp_scope_department" ON "hrbp_department_scope"("csi_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_hrbp_scope_pair" ON "hrbp_department_scope"("employee_id", "csi_department_id");

-- CreateIndex
CREATE INDEX "idx_recruiting_delivery_recruiting" ON "recruiting_delivery_scope"("recruiting_csi_department_id");

-- CreateIndex
CREATE INDEX "idx_recruiting_delivery_delivery" ON "recruiting_delivery_scope"("delivery_csi_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_recruiting_delivery_pair" ON "recruiting_delivery_scope"("recruiting_csi_department_id", "delivery_csi_department_id");

-- CreateIndex
CREATE INDEX "idx_boss_metrics_stat_date" ON "boss_recruiter_daily_metrics"("stat_date");

-- CreateIndex
CREATE INDEX "idx_boss_metrics_employee" ON "boss_recruiter_daily_metrics"("employee_id");

-- CreateIndex
CREATE INDEX "idx_boss_metrics_batch" ON "boss_recruiter_daily_metrics"("import_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_boss_metrics_date_email" ON "boss_recruiter_daily_metrics"("stat_date", "enterprise_email");

-- CreateIndex
CREATE UNIQUE INDEX "project_staff_roster_employee_code_key" ON "project_staff_roster"("employee_code");

-- CreateIndex
CREATE INDEX "idx_project_staff_business_unit" ON "project_staff_roster"("business_unit_csi_id");

-- CreateIndex
CREATE INDEX "idx_project_staff_expected_exit" ON "project_staff_roster"("expected_exit_date");

-- CreateIndex
CREATE INDEX "idx_project_staff_status" ON "project_staff_roster"("current_status");

-- CreateIndex
CREATE INDEX "idx_project_staff_log_staff_time" ON "project_staff_status_change_log"("staff_id", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_staff_ai_profile_staff_id_key" ON "project_staff_ai_profile"("staff_id");

-- CreateIndex
CREATE INDEX "idx_ps_ai_profile_disposition" ON "project_staff_ai_profile"("disposition");

-- CreateIndex
CREATE INDEX "idx_ps_ai_profile_push" ON "project_staff_ai_profile"("push_status");

-- CreateIndex
CREATE INDEX "idx_ps_match_staff_score" ON "project_staff_match"("staff_id", "score");

-- CreateIndex
CREATE INDEX "idx_ps_match_req" ON "project_staff_match"("job_requisition_id");

-- CreateIndex
CREATE INDEX "idx_ps_match_hsm" ON "project_staff_match"("hsm_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ps_match_staff_req" ON "project_staff_match"("staff_id", "job_requisition_id");

-- CreateIndex
CREATE INDEX "idx_ps_investment_emp" ON "project_staff_investment"("employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ps_investment_emp_proj" ON "project_staff_investment"("employee_code", "project_code");

-- CreateIndex
CREATE UNIQUE INDEX "project_staff_archive_employee_code_key" ON "project_staff_archive"("employee_code");

-- CreateIndex
CREATE INDEX "idx_ps_archive_emp" ON "project_staff_archive"("employee_code");



















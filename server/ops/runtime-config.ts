import { prisma } from "@/server/db";
import { promises as fs } from "node:fs";
import path from "node:path";

export type RuntimeConfigSection = string;
export type RuntimeConfigSource = "runtime" | "env" | "default" | "unset";
export type RuntimeConfigSaveTarget = "env_local" | "runtime";

export type RuntimeConfigDefinition = {
  key: string;
  label: string;
  section: RuntimeConfigSection;
  sectionLabel?: string;
  description: string;
  placeholder?: string;
  fileValue?: string | null;
  sourceFiles?: string[];
  defaultValue?: string;
  secret?: boolean;
  editable?: boolean;
  restartRequired?: boolean;
};

export type RuntimeConfigFieldState = RuntimeConfigDefinition & {
  sectionLabel: string;
  editable: boolean;
  restartRequired: boolean;
  secret: boolean;
  envValue: string | null;
  overrideValue: string | null;
  effectiveValue: string | null;
  displayValue: string;
  source: RuntimeConfigSource;
  hasEnvValue: boolean;
  hasOverride: boolean;
  hasEffectiveValue: boolean;
};

export type RuntimeConfigState = {
  fields: RuntimeConfigFieldState[];
  writableEnvFile: string;
  updatedAt: string;
};

export type RuntimeConfigSaveResult = {
  target: RuntimeConfigSaveTarget;
  changedKeys: string[];
  restartRequiredKeys: string[];
  state: RuntimeConfigState;
};

type RuntimeConfigRow = {
  key: string;
  value: string;
};

type RuntimeDelegate = {
  findMany: (args?: unknown) => Promise<RuntimeConfigRow[]>;
  upsert: (args: unknown) => Promise<unknown>;
  delete: (args: unknown) => Promise<unknown>;
};

const SECRET_MASK = "••••••••";
const WRITABLE_ENV_FILE = ".env.local";
const LAST_FILE_ENV = new Map<string, string | null>();

export const KNOWN_CONFIG_DEFINITIONS: RuntimeConfigDefinition[] = [
  {
    key: "INNGEST_BASE_URL",
    label: "Inngest URL",
    section: "inngest",
    description: "Event engine base URL used by AO server-side calls.",
    placeholder: "http://localhost:8288",
    defaultValue: "http://localhost:8288",
  },
  {
    key: "INNGEST_DEV",
    label: "Inngest SDK URL",
    section: "inngest",
    description: "SDK auto-discovery alias; keep aligned with INNGEST_BASE_URL in local dev.",
    placeholder: "http://localhost:8288",
  },
  {
    key: "NEXT_PUBLIC_INNGEST_URL",
    label: "Browser Inngest URL",
    section: "inngest",
    description: "Browser-side mirror for Inngest links.",
    placeholder: "http://localhost:8288",
  },
  {
    key: "INNGEST_SERVE_ORIGIN",
    label: "AO callback host",
    section: "inngest",
    description: "Origin that Inngest can reach when pulling /api/inngest.",
    placeholder: "http://host.docker.internal:3002",
  },
  {
    key: "INNGEST_SERVE_PATH",
    label: "AO callback path",
    section: "inngest",
    description: "Path for the Next.js Inngest serve endpoint.",
    placeholder: "/api/inngest",
    defaultValue: "/api/inngest",
  },
  {
    key: "RAAS_API_BASE_URL",
    label: "RaaS API URL",
    section: "raas",
    description: "Partner RaaS API base URL for reachability and partner calls.",
    placeholder: "http://localhost:3001",
  },
  {
    key: "ALLMETA_BASE_URL",
    label: "Allmeta Studio URL",
    section: "neo4j",
    description: "Allmeta Studio base URL for ontology/domain operations.",
    placeholder: "http://localhost:3500",
  },
  {
    key: "ALLMETA_DOMAIN",
    label: "Allmeta domain",
    section: "neo4j",
    description: "Default ontology domain used by recruitment operations.",
    placeholder: "RAAS-v1",
  },
  {
    key: "NEO4J_INSTANCE_URI",
    label: "Neo4j URI",
    section: "neo4j",
    description: "Direct Neo4j bolt URI for graph sync and audit graph writers.",
    placeholder: "bolt://localhost:7688",
  },
  {
    key: "NEO4J_INSTANCE_USER",
    label: "Neo4j user",
    section: "neo4j",
    description: "Direct Neo4j username.",
    placeholder: "neo4j",
  },
  {
    key: "NEO4J_INSTANCE_PASSWORD",
    label: "Neo4j password",
    section: "neo4j",
    description: "Direct Neo4j password.",
    secret: true,
    placeholder: "leave blank to keep current password",
  },
  {
    key: "NEO4J_INSTANCE_DATABASE",
    label: "Neo4j database",
    section: "neo4j",
    description: "Direct Neo4j database name.",
    placeholder: "neo4j",
    defaultValue: "neo4j",
  },
  {
    key: "NEO4J_SYNC_ENABLED",
    label: "Neo4j sync enabled",
    section: "neo4j",
    description: "Enable scheduled Neo4j event catalog sync.",
    placeholder: "1",
  },
  {
    key: "NEO4J_SYNC_INTERVAL_MS",
    label: "Neo4j sync interval",
    section: "neo4j",
    description: "Scheduled Neo4j event catalog sync interval in ms.",
    placeholder: "300000",
  },
  {
    key: "DATABASE_URL",
    label: "AO database URL",
    section: "deployment",
    description: "AO Prisma database URL. Runtime hot-switch is disabled because the Prisma pool must restart.",
    secret: true,
    editable: false,
    restartRequired: true,
  },
];

const KNOWN_DEFINITIONS_BY_KEY = new Map(KNOWN_CONFIG_DEFINITIONS.map((d) => [d.key, d]));
const ORIGINAL_ENV = new Map<string, string | null>();

type EnvFileEntry = {
  key: string;
  value: string | null;
  file: string;
  section: string;
  description: string;
};

const SECTION_ALIASES: Array<{ test: RegExp; section: string; label: string }> = [
  { test: /inngest|event engine|事件引擎|shared inngest/i, section: "inngest", label: "Inngest / event engine" },
  { test: /raas|robohire|partner|合作|mirror/i, section: "raas", label: "RaaS / partner services" },
  { test: /neo4j|allmeta|ontology|图|知识/i, section: "neo4j", label: "Allmeta / Neo4j" },
  { test: /persistence|postgres|database|部署|deployment|archive|monitor|存储/i, section: "deployment", label: "Deployment / persistence" },
  { test: /llm|ai|model/i, section: "ai", label: "AI gateway" },
  { test: /minio|storage|resume binary/i, section: "storage", label: "Object storage" },
  { test: /wecom|notify|notification|告警|通知/i, section: "notifications", label: "Notifications" },
];

function normalizeSection(raw: string): { section: string; label: string } {
  const clean = raw
    .replace(/[═─━#]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\d\s.、-]+/, "")
    .trim();
  const hit = SECTION_ALIASES.find((s) => s.test.test(clean));
  if (hit) return { section: hit.section, label: hit.label };
  if (!clean) return { section: "other", label: "Other" };
  return {
    section: clean.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_").replace(/^_+|_+$/g, "") || "other",
    label: clean,
  };
}

function parseEnvValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const noInlineComment = trimmed.replace(/\s+#.*$/, "").trim();
  if (
    (noInlineComment.startsWith('"') && noInlineComment.endsWith('"')) ||
    (noInlineComment.startsWith("'") && noInlineComment.endsWith("'"))
  ) {
    return noInlineComment.slice(1, -1);
  }
  return noInlineComment;
}

function parseEnvAssignment(rawLine: string): { key: string; value: string | null } | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  return { key: m[1], value: parseEnvValue(m[2]) };
}

async function readEnvFile(file: string): Promise<EnvFileEntry[]> {
  const abs = path.join(process.cwd(), file);
  let text = "";
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    return [];
  }

  const entries: EnvFileEntry[] = [];
  let current = normalizeSection(file);
  const comments: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      comments.length = 0;
      continue;
    }
    if (line.startsWith("#")) {
      const comment = line.replace(/^#+\s?/, "").trim();
      if (comment && /[═─━]{2,}|──|══/.test(comment)) {
        const next = normalizeSection(comment);
        if (next.label !== "Other") current = next;
      }
      if (comment && !/[═─━]{2,}/.test(comment)) {
        comments.push(comment);
        if (comments.length > 3) comments.shift();
      }
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    entries.push({
      key,
      value: parseEnvValue(m[2]),
      file,
      section: current.section,
      description: comments.join(" "),
    });
    comments.length = 0;
  }
  return entries;
}

function labelFromKey(key: string): string {
  return key
    .replace(/^NEXT_PUBLIC_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isSecretKey(key: string): boolean {
  return /(SECRET|PASSWORD|TOKEN|API_KEY|SIGNING_KEY|EVENT_KEY|DATABASE_URL|POSTGRES_URL|PG_URL)$/i.test(key) ||
    /(SECRET|PASSWORD|TOKEN|API_KEY|DATABASE_URL|POSTGRES_URL|PG_URL)/i.test(key);
}

function knownSectionLabel(section: string): string {
  return SECTION_ALIASES.find((s) => s.section === section)?.label ?? labelFromKey(section);
}

function envFilesToScan(): string[] {
  const nodeEnv = process.env.NODE_ENV || "development";
  const files = [
    ".env.example",
    ".env",
    nodeEnv ? `.env.${nodeEnv}` : null,
    nodeEnv === "test" ? null : ".env.local",
    nodeEnv === "test" ? null : nodeEnv ? `.env.${nodeEnv}.local` : null,
  ].filter(Boolean) as string[];
  return Array.from(new Set(files));
}

export async function getRuntimeConfigDefinitions(): Promise<RuntimeConfigDefinition[]> {
  const entries = (await Promise.all(envFilesToScan().map((file) => readEnvFile(file)))).flat();
  const byKey = new Map<string, RuntimeConfigDefinition>();

  for (const entry of entries) {
    const known = KNOWN_DEFINITIONS_BY_KEY.get(entry.key);
    const sectionLabel = known?.sectionLabel ?? knownSectionLabel(known?.section ?? entry.section);
    const prev = byKey.get(entry.key);
    byKey.set(entry.key, {
      key: entry.key,
      label: known?.label ?? prev?.label ?? labelFromKey(entry.key),
      section: known?.section ?? prev?.section ?? entry.section,
      sectionLabel: prev?.sectionLabel ?? sectionLabel,
      description: known?.description ?? prev?.description ?? entry.description ?? "",
      placeholder: known?.placeholder ?? prev?.placeholder ?? (entry.file === ".env.example" ? entry.value ?? undefined : undefined),
      fileValue: entry.file === ".env.example" ? (prev?.fileValue ?? null) : entry.value,
      sourceFiles: Array.from(new Set([...(prev?.sourceFiles ?? []), entry.file])),
      defaultValue: known?.defaultValue ?? prev?.defaultValue,
      secret: known?.secret ?? prev?.secret ?? isSecretKey(entry.key),
      editable: known?.editable ?? prev?.editable ?? true,
      restartRequired: known?.restartRequired ?? prev?.restartRequired ?? !KNOWN_DEFINITIONS_BY_KEY.has(entry.key),
    });
  }

  for (const known of KNOWN_CONFIG_DEFINITIONS) {
    if (!byKey.has(known.key)) {
      byKey.set(known.key, {
        ...known,
        sectionLabel: known.sectionLabel ?? knownSectionLabel(known.section),
        sourceFiles: [],
        fileValue: null,
      });
    }
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const section = (a.sectionLabel ?? a.section).localeCompare(b.sectionLabel ?? b.section);
    return section !== 0 ? section : a.key.localeCompare(b.key);
  });
}

function runtimeDelegate(): RuntimeDelegate | null {
  return ((prisma as unknown as { runtimeConfig?: unknown }).runtimeConfig as RuntimeDelegate | undefined) ?? null;
}

function redact(def: RuntimeConfigDefinition, value: string | null): string {
  if (!value) return "—";
  return def.secret ? SECRET_MASK : value;
}

async function readRows(keys?: string[]): Promise<Map<string, string>> {
  const delegate = runtimeDelegate();
  if (!delegate) return new Map();
  try {
    const rows = await delegate.findMany({
      where: keys ? { key: { in: keys } } : undefined,
      select: { key: true, value: true },
    });
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    return new Map();
  }
}

export async function applyRuntimeConfigToEnv(): Promise<void> {
  const defs = await getRuntimeConfigDefinitions();
  const overrides = await readRows(defs.map((d) => d.key));
  const currentKeys = new Set(defs.map((d) => d.key));
  for (const def of defs) {
    const fileValue = def.fileValue ?? null;
    const previousFileValue = LAST_FILE_ENV.has(def.key) ? LAST_FILE_ENV.get(def.key) ?? null : null;
    const processValue = process.env[def.key] ?? null;
    if (overrides.has(def.key)) {
      if (!ORIGINAL_ENV.has(def.key)) ORIGINAL_ENV.set(def.key, process.env[def.key] ?? null);
      const override = overrides.get(def.key);
      if (override == null || override === "") delete process.env[def.key];
      else process.env[def.key] = override;
    } else if (fileValue != null) {
      const processLooksFileBacked =
        processValue == null ||
        processValue === fileValue ||
        (LAST_FILE_ENV.has(def.key) && processValue === previousFileValue);
      if (processLooksFileBacked) {
        process.env[def.key] = fileValue;
      }
    } else if (LAST_FILE_ENV.has(def.key) && processValue === previousFileValue) {
      if (def.defaultValue != null) process.env[def.key] = def.defaultValue;
      else delete process.env[def.key];
    } else if (process.env[def.key] == null && def.defaultValue != null) {
      process.env[def.key] = def.defaultValue;
    }
    LAST_FILE_ENV.set(def.key, fileValue);
  }
  for (const [key, previousFileValue] of LAST_FILE_ENV.entries()) {
    if (currentKeys.has(key) || previousFileValue == null) continue;
    if (process.env[key] === previousFileValue) delete process.env[key];
    LAST_FILE_ENV.set(key, null);
  }
}

export async function getRuntimeConfigState(): Promise<RuntimeConfigState> {
  const defs = await getRuntimeConfigDefinitions();
  const overrides = await readRows(defs.map((d) => d.key));
  const fields = defs.map((def) => {
    const original = ORIGINAL_ENV.has(def.key) ? ORIGINAL_ENV.get(def.key) : null;
    const processValue = process.env[def.key] ?? null;
    const previousFileValue = LAST_FILE_ENV.has(def.key) ? LAST_FILE_ENV.get(def.key) ?? null : null;
    const processLooksFileBacked =
      processValue == null ||
      processValue === def.fileValue ||
      (LAST_FILE_ENV.has(def.key) && processValue === previousFileValue);
    const base = processLooksFileBacked
      ? (def.fileValue ?? processValue ?? original ?? null)
      : (processValue ?? def.fileValue ?? original ?? null);
    const override = overrides.get(def.key) ?? null;
    const envValue = override == null ? (process.env[def.key] ?? base) : base;
    const effective = override ?? base ?? process.env[def.key] ?? def.defaultValue ?? null;
    const source: RuntimeConfigSource =
      override != null
        ? "runtime"
        : process.env[def.key] != null || base != null
          ? "env"
          : def.defaultValue != null
            ? "default"
            : "unset";
    const secret = Boolean(def.secret);
    return {
      ...def,
      fileValue: secret ? null : def.fileValue ?? null,
      sectionLabel: def.sectionLabel ?? knownSectionLabel(def.section),
      editable: def.editable !== false,
      restartRequired: Boolean(def.restartRequired),
      secret,
      envValue: secret ? null : envValue,
      overrideValue: secret ? null : override,
      effectiveValue: secret ? null : effective,
      displayValue: redact(def, effective),
      source,
      hasEnvValue: Boolean(base),
      hasOverride: override != null,
      hasEffectiveValue: Boolean(effective),
    };
  });
  return { fields, writableEnvFile: WRITABLE_ENV_FILE, updatedAt: new Date().toISOString() };
}

function normalizeValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("CONFIG_VALUE_MUST_BE_STRING");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function setEnvFromCurrentState(def: RuntimeConfigDefinition, override: string | null): void {
  const base = def.fileValue ?? (ORIGINAL_ENV.has(def.key) ? ORIGINAL_ENV.get(def.key) : null);
  const next = override ?? base ?? def?.defaultValue ?? null;
  if (next == null || next === "") delete process.env[def.key];
  else process.env[def.key] = next;
}

function quoteEnvValue(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@%+=,?&-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function envLineFor(key: string, value: string): string {
  return `${key}=${quoteEnvValue(value)}`;
}

async function writeEnvLocalValues(values: Map<string, string | null>): Promise<void> {
  const abs = path.join(process.cwd(), WRITABLE_ENV_FILE);
  let text = "";
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    text = "";
  }

  const lines = text.length > 0 ? text.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const seen = new Set<string>();
  const nextLines: string[] = [];

  for (const line of lines) {
    const assignment = parseEnvAssignment(line);
    if (!assignment || !values.has(assignment.key)) {
      nextLines.push(line);
      continue;
    }

    const value = values.get(assignment.key) ?? null;
    if (value == null) {
      seen.add(assignment.key);
      continue;
    }

    if (!seen.has(assignment.key)) {
      nextLines.push(envLineFor(assignment.key, value));
      seen.add(assignment.key);
    }
  }

  const appendKeys = Array.from(values.entries()).filter(([key, value]) => value != null && !seen.has(key));
  if (appendKeys.length > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== "") nextLines.push("");
    nextLines.push("# AO UI managed environment overrides");
    for (const [key, value] of appendKeys) {
      nextLines.push(envLineFor(key, value ?? ""));
    }
  }

  await fs.writeFile(abs, `${nextLines.join("\n")}\n`, "utf8");
}

async function syncEnvKeysFromFiles(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const defs = await getRuntimeConfigDefinitions();
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of keys) {
    const def = byKey.get(key);
    const fallback = ORIGINAL_ENV.has(key) ? ORIGINAL_ENV.get(key) : null;
    const next = def?.fileValue ?? fallback ?? def?.defaultValue ?? null;
    if (next == null || next === "") delete process.env[key];
    else process.env[key] = next;
    LAST_FILE_ENV.set(key, def?.fileValue ?? null);
  }
}

function normalizeSaveTarget(target?: RuntimeConfigSaveTarget): RuntimeConfigSaveTarget {
  return target === "runtime" ? "runtime" : "env_local";
}

export async function saveRuntimeConfig(
  values: Record<string, unknown>,
  options: { target?: RuntimeConfigSaveTarget } = {},
): Promise<RuntimeConfigSaveResult> {
  const target = normalizeSaveTarget(options.target);
  const delegate = runtimeDelegate();
  if (target === "runtime" && !delegate) throw new Error("RUNTIME_CONFIG_STORE_UNAVAILABLE");
  const defs = await getRuntimeConfigDefinitions();
  const definitionsByKey = new Map(defs.map((d) => [d.key, d]));

  const normalized = new Map<string, string | null>();

  for (const [key, raw] of Object.entries(values)) {
    const def = definitionsByKey.get(key);
    if (!def) throw new Error(`UNSUPPORTED_CONFIG_KEY:${key}`);
    if (def.editable === false) throw new Error(`CONFIG_KEY_NOT_EDITABLE:${key}`);
    const value = normalizeValue(raw);

    if (def.secret && value == null) continue;
    normalized.set(key, value);
  }

  const changedKeys = Array.from(normalized.keys());
  const restartRequiredKeys = changedKeys.filter((key) => Boolean(definitionsByKey.get(key)?.restartRequired));

  if (target === "env_local") {
    await writeEnvLocalValues(normalized);
    await Promise.all(changedKeys.map((key) => delegate?.delete({ where: { key } }).catch(() => null)));
    await syncEnvKeysFromFiles(changedKeys);
    return {
      target,
      changedKeys,
      restartRequiredKeys,
      state: await getRuntimeConfigState(),
    };
  }

  for (const [key, value] of normalized.entries()) {
    const def = definitionsByKey.get(key)!;

    if (value == null) {
      await delegate!.delete({ where: { key } }).catch(() => null);
      setEnvFromCurrentState(def, null);
    } else {
      if (!ORIGINAL_ENV.has(key)) ORIGINAL_ENV.set(key, process.env[key] ?? null);
      await delegate!.upsert({
        where: { key },
        create: { key, value, updatedBy: "operator" },
        update: { value, updatedBy: "operator" },
      });
      process.env[key] = value;
    }
  }

  return {
    target,
    changedKeys,
    restartRequiredKeys,
    state: await getRuntimeConfigState(),
  };
}

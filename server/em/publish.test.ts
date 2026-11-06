import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Use vi.hoisted so the mocks are available inside vi.mock factories,
// which run before the surrounding module body.
const { sendMock, prismaMock } = vi.hoisted(() => {
  return {
    sendMock: vi.fn(async () => ({ ids: ["sent"] })),
    prismaMock: {
      eventInstance: {
        create: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => null),
      },
      auditLog: {
        create: vi.fn(async () => ({})),
      },
      emSystemStatus: {
        upsert: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => null),
      },
      eventDefinition: {
        findUnique: vi.fn(async () => null),
      },
    },
  };
});

vi.mock("../inngest/client", () => ({
  inngest: { send: sendMock },
}));
vi.mock("../db", () => ({
  prisma: prismaMock,
}));

import { em } from "./index";
import { _resetForTests } from "./degraded-mode";
import { invalidateCache } from "./registry";

const VALID_RESUME_DOWNLOADED = {
  entity_type: "Resume",
  entity_id: "r-1",
  event_id: "evt-ext-1",
  payload: {
    upload_id: "u-100",
    bucket: "recruit-resume-raw",
    object_key: "abc/u-100.pdf",
    job_requisition_id: "jr-7",
  },
  trace: { trace_id: "trace-xyz" },
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  invalidateCache();
  // Default: passthrough OFF + strict schema ON for existing rejection tests
  // (they explicitly test rejection behavior). Passthrough tests override
  // EM_PASSTHROUGH="1" themselves.
  process.env.EM_PASSTHROUGH = "0";
  process.env.EM_STRICT_SCHEMA = "true";
});

afterEach(() => {
  delete process.env.EM_PASSTHROUGH;
  delete process.env.EM_STRICT_SCHEMA;
});

describe("em.publish — happy path", () => {
  it("validates, persists, and forwards a well-formed event", async () => {
    const r = await em.publish("RESUME_DOWNLOADED", VALID_RESUME_DOWNLOADED, {
      source: "raas-bridge",
      externalEventId: "evt-ext-1",
    });

    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.schemaVersionUsed).toBe("1.0");
      expect(r.eventId).toBeTruthy();
    }

    // EventInstance row written with status=accepted.
    expect(prismaMock.eventInstance.create).toHaveBeenCalledTimes(1);
    const writeArgs = prismaMock.eventInstance.create.mock.calls[0][0];
    expect(writeArgs.data.status).toBe("accepted");
    expect(writeArgs.data.name).toBe("RESUME_DOWNLOADED");
    expect(writeArgs.data.source).toBe("raas-bridge");
    expect(writeArgs.data.externalEventId).toBe("evt-ext-1");
    expect(writeArgs.data.schemaVersionUsed).toBe("1.0");

    // AuditLog row written with derived trace_id.
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.create.mock.calls[0][0].data.traceId).toBe("trace-xyz");

    // Inngest send fired with externalEventId as idempotency key.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].id).toBe("evt-ext-1");
    expect(sendMock.mock.calls[0][0].name).toBe("RESUME_DOWNLOADED");
  });
});

describe("em.publish — schema reject", () => {
  it("rejects malformed payload, persists rejection_schema, emits EVENT_REJECTED", async () => {
    const bad = { ...VALID_RESUME_DOWNLOADED, payload: { /* missing upload_id */ bucket: "x", object_key: "y" } };
    const r = await em.publish("RESUME_DOWNLOADED", bad, {
      source: "raas-bridge",
      externalEventId: "evt-bad-1",
    });

    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("schema");

    // 2 EventInstance writes: 1 for the rejected original, 1 for the
    // EVENT_REJECTED meta event.
    const created = prismaMock.eventInstance.create.mock.calls.map((c: any) => c[0].data);
    expect(created.length).toBe(2);
    expect(created.find((d: any) => d.status === "rejected_schema")).toBeTruthy();
    expect(created.find((d: any) => d.status === "meta_rejection")).toBeTruthy();

    // Inngest send fired ONLY for EVENT_REJECTED (not the bad event).
    const sentNames = sendMock.mock.calls.map((c) => c[0].name);
    expect(sentNames).toContain("EVENT_REJECTED");
    expect(sentNames).not.toContain("RESUME_DOWNLOADED");
  });

  it("respects emitRejectionOnFailure=false", async () => {
    const bad = { ...VALID_RESUME_DOWNLOADED, payload: { bucket: "x", object_key: "y" } };
    await em.publish("RESUME_DOWNLOADED", bad, {
      source: "raas-bridge",
      externalEventId: "evt-bad-2",
      emitRejectionOnFailure: false,
    });
    const sentNames = sendMock.mock.calls.map((c) => c[0].name);
    expect(sentNames).not.toContain("EVENT_REJECTED");
  });
});

describe("em.publish — unregistered event name", () => {
  it("returns no_schema and emits EVENT_REJECTED with retry guidance", async () => {
    const r = await em.publish("TOTALLY_MADE_UP_EVENT", { foo: 1 }, {
      source: "test",
    });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("no_schema");

    const sentNames = sendMock.mock.calls.map((c) => c[0].name);
    expect(sentNames).toContain("EVENT_REJECTED");
    const rejectionEnvelope = sendMock.mock.calls.find(
      (c) => c[0].name === "EVENT_REJECTED",
    )?.[0]?.data as any;
    expect(rejectionEnvelope?.payload?.rejection_type).toBe("SCHEMA_VALIDATION_FAILED");
    expect(rejectionEnvelope?.payload?.retry_guidance).toMatch(/Neo4j|builtin/);
  });
});

describe("em.publish — duplicate", () => {
  it("returns duplicate silently when externalEventId already in EventInstance", async () => {
    prismaMock.eventInstance.findUnique.mockResolvedValueOnce({
      id: "prior-id",
      status: "accepted",
    });
    const r = await em.publish("RESUME_DOWNLOADED", VALID_RESUME_DOWNLOADED, {
      source: "raas-bridge",
      externalEventId: "evt-dup-1",
    });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("duplicate");
    // No new EventInstance write (the dup check returned early).
    expect(prismaMock.eventInstance.create).not.toHaveBeenCalled();
    // No EVENT_REJECTED — duplicates are silent (spec v2 §6.1).
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("em.publish — degraded mode fallback", () => {
  it("when EM is degraded, raw inngest.send is called and no audit row is written", async () => {
    // Force degraded by activating once.
    const { activate, isDegraded } = await import("./degraded-mode");
    activate(new Error("simulated outage"));
    expect(isDegraded()).toBe(true);

    const r = await em.publish("RESUME_DOWNLOADED", VALID_RESUME_DOWNLOADED, {
      source: "raas-bridge",
      externalEventId: "evt-degraded-1",
    });

    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("em_degraded");

    // The fallback path called send(), but did NOT write EventInstance or AuditLog.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.eventInstance.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("when persist throws, activates degraded and fallback-sends", async () => {
    prismaMock.eventInstance.create.mockRejectedValueOnce(new Error("disk full"));

    const r = await em.publish("RESUME_DOWNLOADED", VALID_RESUME_DOWNLOADED, {
      source: "raas-bridge",
      externalEventId: "evt-disk-1",
    });

    // The publish ends in em_degraded because persistence threw.
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("em_degraded");

    // We DID still call send() in the fallback path.
    expect(sendMock).toHaveBeenCalled();
  });
});

describe("em.publish — cascade causality", () => {
  it("records caused_by_event_id when causedBy is provided", async () => {
    await em.publish("RESUME_DOWNLOADED", VALID_RESUME_DOWNLOADED, {
      source: "rpa.resumeParserAgent",
      externalEventId: "evt-cascade-1",
      causedBy: { eventId: "parent-evt-7", name: "RESUME_DOWNLOADED" },
    });
    const writeArgs = prismaMock.eventInstance.create.mock.calls[0][0];
    expect(writeArgs.data.causedByEventId).toBe("parent-evt-7");
    expect(writeArgs.data.causedByName).toBe("RESUME_DOWNLOADED");
  });
});

// ── Passthrough mode ──────────────────────────────────────────────────────────
//
// When EM_PASSTHROUGH=1 (default ON in production code), events that fail
// schema validation — either no schema registered (no_schema) or data mismatch
// (schema) — are persisted with status='accepted_passthrough' and forwarded to
// Inngest. This lets operators audit ALL events until schemas are formalized.

describe("em.publish — passthrough mode (no_schema)", () => {
  it("accepts unregistered event, persists accepted_passthrough, forwards to Inngest", async () => {
    process.env.EM_PASSTHROUGH = "1";

    const r = await em.publish("TOTALLY_MADE_UP_EVENT", { foo: 1 }, {
      source: "test",
    });

    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.schemaVersionUsed).toBe("passthrough");
      expect(r.eventId).toBeTruthy();
    }

    // EventInstance written with status=accepted_passthrough
    expect(prismaMock.eventInstance.create).toHaveBeenCalledTimes(1);
    const writeArgs = prismaMock.eventInstance.create.mock.calls[0][0];
    expect(writeArgs.data.status).toBe("accepted_passthrough");
    expect(writeArgs.data.schemaVersionUsed).toBe("passthrough");
    expect(writeArgs.data.name).toBe("TOTALLY_MADE_UP_EVENT");

    // Inngest send fired for the original event (not EVENT_REJECTED)
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].name).toBe("TOTALLY_MADE_UP_EVENT");

    // No EVENT_REJECTED meta event emitted
    const sentNames = sendMock.mock.calls.map((c) => c[0].name);
    expect(sentNames).not.toContain("EVENT_REJECTED");
  });
});

describe("em.publish — passthrough mode (schema mismatch)", () => {
  it("accepts event with failing schema, records errors in schemaErrors, forwards to Inngest", async () => {
    process.env.EM_PASSTHROUGH = "1";

    const bad = { ...VALID_RESUME_DOWNLOADED, payload: { /* missing upload_id */ bucket: "x", object_key: "y" } };
    const r = await em.publish("RESUME_DOWNLOADED", bad, {
      source: "raas-bridge",
      externalEventId: "evt-passthrough-schema-1",
    });

    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.schemaVersionUsed).toBe("passthrough");
    }

    // EventInstance written with status=accepted_passthrough and schemaErrors populated
    expect(prismaMock.eventInstance.create).toHaveBeenCalledTimes(1);
    const writeArgs = prismaMock.eventInstance.create.mock.calls[0][0];
    expect(writeArgs.data.status).toBe("accepted_passthrough");
    expect(writeArgs.data.schemaErrors).toBeTruthy();
    // schemaErrors is stored as JSON string — parse and verify it has entries
    const errors = JSON.parse(writeArgs.data.schemaErrors as string);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);

    // Inngest send fired for the original event
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].name).toBe("RESUME_DOWNLOADED");
    expect(sendMock.mock.calls[0][0].id).toBe("evt-passthrough-schema-1");

    // No EVENT_REJECTED meta event emitted
    const sentNames = sendMock.mock.calls.map((c) => c[0].name);
    expect(sentNames).not.toContain("EVENT_REJECTED");
  });
});

describe("em.validate", () => {
  it("returns ok=true with normalized data for valid input", async () => {
    const r = await em.validate("RESUME_DOWNLOADED", VALID_RESUME_DOWNLOADED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe("1.0");
  });

  it("returns ok=false with structured errors for invalid input", async () => {
    const r = await em.validate("RESUME_DOWNLOADED", { payload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.triedVersions).toEqual(["1.0"]);
    }
  });

  it("returns no_schema-style empty errors for unknown event", async () => {
    const r = await em.validate("TOTALLY_UNKNOWN", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.triedVersions).toEqual([]);
  });
});

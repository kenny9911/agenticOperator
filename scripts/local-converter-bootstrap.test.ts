import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

type BootstrapEnv = Record<string, string | undefined>;
type Decision = {
  action: "start" | "skip";
  reason?: string;
  configuredUrl?: string;
  started?: boolean;
};

type BootstrapModule = {
  decideLocalConverterBootstrap: (
    env: BootstrapEnv,
    dockerAvailable: boolean,
  ) => Decision;
  ensureLocalDocumentConverter: (options: {
    env: BootstrapEnv;
    dockerAvailable: boolean;
    root: string;
    execFile: (...args: unknown[]) => unknown;
    log: (message: string) => void;
    warn: (message: string) => void;
  }) => Decision;
};

const repoRoot = process.cwd();
const helperUrl = pathToFileURL(
  join(repoRoot, "scripts", "local-converter-bootstrap.mjs"),
).href;
const {
  decideLocalConverterBootstrap,
  ensureLocalDocumentConverter,
} = (await import(helperUrl)) as BootstrapModule;

describe("local document converter bootstrap decision", () => {
  it.each([
    "http://127.0.0.1:3009",
    "http://localhost:3009",
    "http://[::1]:3009",
  ])("starts for matching loopback origin %s when Docker is available", (url) => {
    expect(
      decideLocalConverterBootstrap(
        { DOCUMENT_CONVERTER_URL: url, GOTENBERG_PORT: "3009" },
        true,
      ),
    ).toMatchObject({ action: "start", configuredUrl: url });
  });

  it("does not start when explicitly disabled", () => {
    expect(
      decideLocalConverterBootstrap(
        {
          DOCUMENT_CONVERTER_URL: "http://127.0.0.1:3009",
          DOCUMENT_CONVERTER_AUTO_START: "0",
        },
        true,
      ),
    ).toEqual({ action: "skip", reason: "disabled" });
  });

  it("does not start for a remote converter or without Docker", () => {
    expect(
      decideLocalConverterBootstrap(
        { DOCUMENT_CONVERTER_URL: "http://converter.internal:3000" },
        true,
      ),
    ).toMatchObject({ action: "skip", reason: "remote-url" });
    expect(
      decideLocalConverterBootstrap(
        { DOCUMENT_CONVERTER_URL: "http://127.0.0.1:3009" },
        false,
      ),
    ).toMatchObject({ action: "skip", reason: "docker-unavailable" });
  });

  it("rejects HTTPS loopback because local Compose serves plain HTTP", () => {
    expect(
      decideLocalConverterBootstrap(
        { DOCUMENT_CONVERTER_URL: "https://127.0.0.1:3009" },
        true,
      ),
    ).toMatchObject({ action: "skip", reason: "protocol-mismatch" });
  });

  it("rejects an effective URL port that differs from GOTENBERG_PORT", () => {
    expect(
      decideLocalConverterBootstrap(
        { DOCUMENT_CONVERTER_URL: "http://127.0.0.1", GOTENBERG_PORT: "3009" },
        true,
      ),
    ).toMatchObject({ action: "skip", reason: "port-mismatch" });
    expect(
      decideLocalConverterBootstrap(
        { DOCUMENT_CONVERTER_URL: "http://127.0.0.1:3010", GOTENBERG_PORT: "3009" },
        true,
      ),
    ).toMatchObject({ action: "skip", reason: "port-mismatch" });
  });
});

describe("local document converter bootstrap execution", () => {
  it("runs Compose, then probes the configured host origin without a shell", () => {
    const execFile = vi.fn();
    const log = vi.fn();
    const warn = vi.fn();
    const env = {
      DOCUMENT_CONVERTER_URL: "http://127.0.0.1:3009",
      GOTENBERG_PORT: "3009",
    };

    const result = ensureLocalDocumentConverter({
      env,
      dockerAvailable: true,
      root: repoRoot,
      execFile,
      log,
      warn,
    });

    expect(result).toMatchObject({ action: "start", started: true });
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["compose", "-f", "docker-compose.gotenberg.yml", "up", "-d", "--wait"],
      { cwd: repoRoot, stdio: "inherit", env },
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "curl",
      ["-fsS", "--max-time", "5", "http://127.0.0.1:3009/health"],
      { cwd: repoRoot, stdio: "ignore", env },
    );
    expect(log).toHaveBeenLastCalledWith(
      "local document converter is healthy at http://127.0.0.1:3009",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("soft-fails without claiming health when the host probe cannot connect", () => {
    const execFile = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("connection refused");
      });
    const log = vi.fn();
    const warn = vi.fn();

    const result = ensureLocalDocumentConverter({
      env: { DOCUMENT_CONVERTER_URL: "http://127.0.0.1:3009" },
      dockerAvailable: true,
      root: repoRoot,
      execFile,
      log,
      warn,
    });

    expect(result).toMatchObject({ action: "start", started: false });
    expect(execFile.mock.calls.map(([command]) => command)).toEqual([
      "docker",
      "curl",
    ]);
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("is healthy"),
    );
    expect(warn).toHaveBeenCalledWith(
      "document converter host health probe failed: connection refused",
    );
    expect(warn).toHaveBeenCalledWith("manual: `npm run converter:up`");
  });

  it("soft-fails with the exact manual recovery command", () => {
    const warn = vi.fn();
    const result = ensureLocalDocumentConverter({
      env: { DOCUMENT_CONVERTER_URL: "http://127.0.0.1:3009" },
      dockerAvailable: true,
      root: repoRoot,
      execFile: () => {
        throw new Error("compose unavailable");
      },
      log: vi.fn(),
      warn,
    });

    expect(result).toMatchObject({ action: "start", started: false });
    expect(warn).toHaveBeenCalledWith("manual: `npm run converter:up`");
  });

  it.each(["dev-bootstrap.mjs", "setup.mjs"])(
    "wires %s through the shared tested helper",
    (scriptName) => {
      const source = readFileSync(join(repoRoot, "scripts", scriptName), "utf8");
      expect(source).toContain('from "./local-converter-bootstrap.mjs"');
      expect(source).toContain("ensureLocalDocumentConverter({");
      expect(source).toContain("dockerAvailable: dockerUp");
    },
  );
});

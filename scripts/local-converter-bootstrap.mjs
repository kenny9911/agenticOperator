import { execFileSync } from "node:child_process";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function decideLocalConverterBootstrap(env, dockerAvailable) {
  const autoStart = env.DOCUMENT_CONVERTER_AUTO_START?.trim().toLowerCase();
  if (autoStart && DISABLED_VALUES.has(autoStart)) {
    return { action: "skip", reason: "disabled" };
  }

  const configuredUrl = env.DOCUMENT_CONVERTER_URL?.trim();
  if (!configuredUrl) {
    return { action: "skip", reason: "missing-url" };
  }

  let converterUrl;
  try {
    converterUrl = new URL(configuredUrl);
  } catch {
    return { action: "skip", reason: "invalid-url", configuredUrl };
  }

  if (
    !["http:", "https:"].includes(converterUrl.protocol) ||
    converterUrl.username ||
    converterUrl.password ||
    converterUrl.pathname !== "/" ||
    converterUrl.search ||
    converterUrl.hash
  ) {
    return { action: "skip", reason: "invalid-url", configuredUrl };
  }

  if (converterUrl.protocol !== "http:") {
    return { action: "skip", reason: "protocol-mismatch", configuredUrl };
  }

  if (!LOCAL_HOSTNAMES.has(converterUrl.hostname)) {
    return { action: "skip", reason: "remote-url", configuredUrl };
  }

  const composePortRaw = env.GOTENBERG_PORT?.trim() || "3009";
  const composePort = Number(composePortRaw);
  const converterPort = Number(converterUrl.port || "80");
  if (
    !/^\d+$/.test(composePortRaw) ||
    !Number.isInteger(composePort) ||
    composePort < 1 ||
    composePort > 65535 ||
    converterPort !== composePort
  ) {
    return {
      action: "skip",
      reason: "port-mismatch",
      configuredUrl,
      converterPort,
      composePort: composePortRaw,
    };
  }

  if (!dockerAvailable) {
    return { action: "skip", reason: "docker-unavailable", configuredUrl };
  }

  return { action: "start", configuredUrl };
}

export function ensureLocalDocumentConverter({
  env = process.env,
  dockerAvailable,
  root,
  execFile = execFileSync,
  log = console.log,
  warn = console.warn,
}) {
  const decision = decideLocalConverterBootstrap(env, dockerAvailable);

  if (decision.action === "start") {
    let stage = "Compose startup";
    try {
      log(`starting local document converter for ${decision.configuredUrl}…`);
      execFile(
        "docker",
        ["compose", "-f", "docker-compose.gotenberg.yml", "up", "-d", "--wait"],
        { cwd: root, stdio: "inherit", env },
      );
      stage = "host health probe";
      const healthUrl = new URL("/health", decision.configuredUrl).toString();
      execFile(
        "curl",
        ["-fsS", "--max-time", "5", healthUrl],
        { cwd: root, stdio: "ignore", env },
      );
      log(`local document converter is healthy at ${decision.configuredUrl}`);
      return { ...decision, started: true };
    } catch (error) {
      warn(`document converter ${stage} failed: ${error.message}`);
      warn("manual: `npm run converter:up`");
      return { ...decision, started: false, error };
    }
  }

  if (decision.reason === "disabled") {
    warn("document converter auto-start disabled by DOCUMENT_CONVERTER_AUTO_START; manual: `npm run converter:up`");
  } else if (decision.reason === "docker-unavailable") {
    warn("Docker daemon unreachable — skipping local document converter; start Docker, then run `npm run converter:up`.");
  } else if (decision.reason === "remote-url") {
    warn(`configured document converter (${decision.configuredUrl}) is remote; not starting local Gotenberg.`);
  } else if (decision.reason === "protocol-mismatch") {
    warn(`configured local document converter (${decision.configuredUrl}) uses HTTPS, but local Gotenberg Compose serves HTTP; not starting it.`);
  } else if (decision.reason === "port-mismatch") {
    warn(
      `configured document converter port (${decision.converterPort}) does not match GOTENBERG_PORT (${decision.composePort}); align them, then run \`npm run converter:up\`.`,
    );
  } else if (decision.reason === "missing-url") {
    warn("DOCUMENT_CONVERTER_URL is missing; configure it or run `npm run converter:up` after setting the local URL.");
  } else {
    warn(`DOCUMENT_CONVERTER_URL is not a valid HTTP(S) origin (${decision.configuredUrl}); not starting local Gotenberg.`);
  }

  return { ...decision, started: false };
}

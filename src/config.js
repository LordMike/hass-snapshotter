import { existsSync, readFileSync } from "node:fs";

// Options come from /data/options.json when running as a Home Assistant app,
// otherwise from environment variables (local Docker, development).
const OPTIONS_FILE = "/data/options.json";

function fromOptionsFile() {
  if (!existsSync(OPTIONS_FILE)) return null;
  const o = JSON.parse(readFileSync(OPTIONS_FILE, "utf8"));
  return {
    haUrl: o.ha_url,
    haToken: o.ha_token,
    allowedPaths: o.allowed_paths,
    browserIdleSeconds: o.browser_idle_seconds,
    readyTimeoutMs: o.ready_timeout_ms,
  };
}

function fromEnv(env) {
  return {
    haUrl: env.HA_URL,
    haToken: env.HA_TOKEN,
    allowedPaths: env.ALLOWED_PATHS,
    browserIdleSeconds: env.BROWSER_IDLE_SECONDS,
    readyTimeoutMs: env.READY_TIMEOUT_MS,
  };
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return [];
}

function toNumber(value, fallback) {
  const n = Number(value);
  return value === undefined || value === "" || !Number.isFinite(n) ? fallback : n;
}

export function loadConfig(env = process.env) {
  const raw = fromOptionsFile() ?? fromEnv(env);

  if (!raw.haUrl) throw new Error("HA URL is not configured (ha_url / HA_URL)");
  if (!raw.haToken) throw new Error("HA long-lived token is not configured (ha_token / HA_TOKEN)");

  const haUrl = new URL(raw.haUrl);
  if (haUrl.protocol !== "http:" && haUrl.protocol !== "https:") {
    throw new Error(`HA URL must be http(s): ${raw.haUrl}`);
  }

  return {
    haOrigin: haUrl.origin,
    haToken: raw.haToken,
    // Path prefixes that may be rendered, e.g. ["vue-tests", "lovelace/eink"].
    // Empty means any path on the HA origin (except the blocked ones in paths.js).
    allowedPaths: toList(raw.allowedPaths)
      .map((p) => String(p).trim().replace(/^\/+|\/+$/g, ""))
      .filter(Boolean),
    // 0 closes the browser after every render; >0 keeps it for that many idle seconds.
    browserIdleSeconds: toNumber(raw.browserIdleSeconds, 0),
    readyTimeoutMs: toNumber(raw.readyTimeoutMs, 45000),
    port: toNumber(env.PORT, 8080),
    chromiumPath: env.CHROMIUM_PATH || "/usr/bin/chromium-headless-shell",
    headerHeight: 56,
  };
}

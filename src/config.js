import { existsSync, readFileSync } from "node:fs";

// /data/options.json when running as a Home Assistant app, otherwise environment variables.
const OPTIONS_FILE = "/data/options.json";

export function loadConfig(env = process.env) {
  const o = existsSync(OPTIONS_FILE) ? JSON.parse(readFileSync(OPTIONS_FILE, "utf8")) : {};
  const supervisor = env.SUPERVISOR_TOKEN;

  // As an app, the Supervisor's proxy to Core and its token are used unless
  // ha_url / ha_token are set. Standalone Docker needs HA_URL and HA_TOKEN.
  const haUrl = o.ha_url || env.HA_URL || (supervisor && "http://supervisor/core");
  const haToken = o.ha_token || env.HA_TOKEN || supervisor;
  const timeout = Number(o.render_timeout_ms ?? env.RENDER_TIMEOUT_MS);

  let haBase = null;
  let error = null;
  if (!haUrl || !haToken) {
    error = "Home Assistant connection is not configured: set HA_URL and HA_TOKEN (e.g. in .env)";
  } else {
    try {
      const url = new URL(haUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
      haBase = url.href.replace(/\/+$/, "");
    } catch {
      error = `HA URL is not a valid http(s) URL: ${haUrl}`;
    }
  }

  return {
    error, // reported on every request instead of crashing at startup
    haBase,
    haToken,
    renderTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    port: Number(env.PORT) || 8080,
    pagesDir: o.pages_dir || env.PAGES_DIR || "pages",
  };
}

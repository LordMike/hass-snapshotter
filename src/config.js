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

  // Optional HTTP auth: Basic from username + password, or an exact Authorization header value.
  const username = o.auth_username || env.AUTH_USERNAME || "";
  const password = o.auth_password || env.AUTH_PASSWORD || "";
  const header = String(o.auth_header || env.AUTH_HEADER || "").trim();
  let authHeader = null;
  let authBasic = false;
  let authError = null; // refuses every request except /healthz, so a typo never leaves the server open
  if (!username !== !password) {
    authError = "Authentication is misconfigured: set auth_username and auth_password (AUTH_USERNAME, AUTH_PASSWORD) together";
  } else if (header && username) {
    authError = "Authentication is misconfigured: use either auth_username with auth_password, or auth_header, not both";
  } else if (username) {
    authHeader = "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    authBasic = true;
  } else if (header) {
    authHeader = header;
  }

  return {
    authHeader,
    authBasic,
    authError,
    error, // reported on every request instead of crashing at startup
    haBase,
    haToken,
    renderTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    port: Number(env.PORT) || 8080,
    pagesDir: o.pages_dir || env.PAGES_DIR || "pages",
    indexPage: !/^(false|0)$/i.test(String(o.index_page ?? env.INDEX_PAGE ?? "").trim()),
  };
}

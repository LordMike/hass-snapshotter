import { existsSync, readFileSync } from "node:fs";

// /data/options.json when running as a Home Assistant app, otherwise environment variables.
const OPTIONS_FILE = "/data/options.json";

export function loadConfig(env = process.env) {
  const o = existsSync(OPTIONS_FILE) ? JSON.parse(readFileSync(OPTIONS_FILE, "utf8")) : {};
  const haUrl = o.ha_url ?? env.HA_URL;
  const haToken = o.ha_token ?? env.HA_TOKEN;
  if (!haUrl) throw new Error("HA URL is not configured (ha_url / HA_URL)");
  if (!haToken) throw new Error("HA long-lived token is not configured (ha_token / HA_TOKEN)");

  const url = new URL(haUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`HA URL must be http(s): ${haUrl}`);
  const timeout = Number(o.render_timeout_ms ?? env.RENDER_TIMEOUT_MS);

  return {
    haOrigin: url.origin,
    haToken,
    renderTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    port: Number(env.PORT) || 8080,
    // <pagesDir>/<name>.js. The app maps its config folder to /config.
    pagesDir: env.PAGES_DIR || (existsSync("/config") ? "/config/pages" : "pages"),
  };
}

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

  const allowed = o.allowed_paths ?? (env.ALLOWED_PATHS ? env.ALLOWED_PATHS.split(",") : []);
  const num = (v, fallback) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));

  return {
    haOrigin: url.origin,
    haToken,
    // Path prefixes that may be rendered; empty allows any dashboard path.
    allowedPaths: allowed.map((p) => String(p).trim().replace(/^\/+|\/+$/g, "")).filter(Boolean),
    // 0 closes the browser after each render (or burst of queued renders).
    browserIdleSeconds: num(o.browser_idle_seconds ?? env.BROWSER_IDLE_SECONDS, 0),
    readyTimeoutMs: num(o.ready_timeout_ms ?? env.READY_TIMEOUT_MS, 45000),
    port: num(env.PORT, 8080),
    chromiumPath: env.CHROMIUM_PATH || "/usr/bin/chromium-headless-shell",
    // Kept between launches so HA's JS is served from disk cache and V8's code cache.
    profileDir: env.PROFILE_DIR || (existsSync("/data") ? "/data/chromium-profile" : "/tmp/chromium-profile"),
    // Browser-free pages: <pagesDir>/<name>.js. The app maps its config folder to /config.
    pagesDir: env.PAGES_DIR || (existsSync("/config") ? "/config/pages" : "pages"),
  };
}

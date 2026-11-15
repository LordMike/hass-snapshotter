// Renders pages in a child process. Without renderer_keep_alive it renders one
// page and exits, so Takumi, fonts, icons and HA's states are not held in
// memory between renders; with it, the server keeps the process and sends more.
import { HassClient } from "./hass.js";
import { renderPageModule } from "./pages.js";

// Log lines go to the parent as they happen, so a render that times out or
// crashes still shows how far it got on the debug page.
const now = () => performance.timeOrigin + performance.now();
const log = (level, text, t = now()) => process.send({ log: { t, level, text } });
log("info", "renderer process started", performance.timeOrigin);

process.on("message", async ({ config, name, params, haConfig, haConfigAt, keep }) => {
  log("info", "renderer process received the request");
  // A new client per render: HA's states are fetched every time; only the config is passed on.
  const client = new HassClient(config);
  if (haConfig) Object.assign(client, { config: haConfig, configFetched: haConfigAt });
  const end = keep ? undefined : () => process.exit(0);
  try {
    const result = await renderPageModule({ pagesDir: config.pagesDir, client }, name, params, log);
    process.send({ ok: true, ...result, haConfig: client.config, haConfigAt: client.configFetched }, end);
  } catch (err) {
    if (!err.status) console.error(err.stack); // unexpected: keep the trace in the log
    process.send({ ok: false, status: err.status ?? 500, message: err.message, stack: err.status ? undefined : err.stack }, end);
  }
});

// The server is gone: do not linger.
process.on("disconnect", () => process.exit(0));

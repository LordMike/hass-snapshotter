// Renders one page in a child process, then exits, so Takumi, fonts and
// icons are not held in memory between renders.
import { HassClient } from "./hass.js";
import { renderPageModule } from "./pages.js";

process.once("message", async ({ config, name, params, knownIds, haConfig }) => {
  try {
    const client = new HassClient(config);
    if (haConfig) client.config = haConfig;
    const result = await renderPageModule({ pagesDir: config.pagesDir, client }, name, params, knownIds);
    process.send({ ok: true, ...result, haConfig: client.config }, () => process.exit(0));
  } catch (err) {
    process.send({ ok: false, status: err.status ?? 500, message: err.message }, () => process.exit(0));
  }
});

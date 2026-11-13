// Renders one page in a child process, then exits, so Takumi, fonts, icons
// and HA's states are not held in memory between renders.
import { HassClient } from "./hass.js";
import { renderPageModule } from "./pages.js";

process.once("message", async ({ config, name, params, haConfig, haConfigAt }) => {
  const client = new HassClient(config);
  if (haConfig) Object.assign(client, { config: haConfig, configFetched: haConfigAt });
  try {
    const result = await renderPageModule({ pagesDir: config.pagesDir, client }, name, params);
    process.send({ ok: true, ...result, haConfig: client.config, haConfigAt: client.configFetched }, () => process.exit(0));
  } catch (err) {
    if (!err.status) console.error(err.stack); // unexpected: keep the trace in the log
    process.send({ ok: false, status: err.status ?? 500, message: err.message }, () => process.exit(0));
  }
});

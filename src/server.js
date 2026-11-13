import http from "node:http";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { HassClient } from "./hass.js";
import { NAME, listPages } from "./pages.js";
import { PALETTES } from "./image.js";

const config = loadConfig();
const MAX_WAITING = 8;

let haConfig = null; // HA's /api/config, reused across renders for an hour
let haConfigAt = 0;

const fail = (status, message) => Object.assign(new Error(message), { status });

function parseParams(q) {
  for (const k of q.keys()) if (k !== "palette") throw fail(400, `Unknown parameter "${k}"; the only parameter is palette`);
  const palette = q.get("palette") ?? undefined;
  if (palette !== undefined && !(palette in PALETTES)) throw fail(400, `palette must be one of ${Object.keys(PALETTES).join(", ")}`);
  return { palette };
}

// Each render runs in a child process that exits afterwards, so the renderer,
// fonts and icons are not held in memory between renders. One at a time keeps
// peak memory to one child.
let queue = Promise.resolve();
let waiting = 0;

function render(name, params) {
  if (waiting >= MAX_WAITING) throw fail(503, "Too many renders queued; try again shortly");
  waiting++;
  const job = queue.then(() => runChild(name, params)).finally(() => waiting--);
  queue = job.catch(() => {});
  return job;
}

function runChild(name, params) {
  return new Promise((resolvePromise, reject) => {
    const child = fork(new URL("./page-worker.js", import.meta.url), { serialization: "advanced" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.renderTimeoutMs);
    const done = () => clearTimeout(timer);
    child.once("message", (msg) => {
      done();
      msg.ok ? resolvePromise(msg) : reject(fail(msg.status, msg.message));
    });
    child.once("error", (err) => {
      done();
      reject(fail(500, `Cannot start the renderer: ${err.message}`));
    });
    child.once("exit", (code, signal) => {
      done();
      reject(
        timedOut
          ? fail(504, `Rendering ${name} took longer than render_timeout_ms (${config.renderTimeoutMs} ms)`)
          : fail(500, `Renderer for ${name} stopped unexpectedly (${signal ?? `exit ${code}`}); see the log`),
      );
    });
    child.send({ config, name, params, haConfig, haConfigAt });
  });
}

async function handlePage(res, file, query) {
  const format = file.endsWith(".html") ? "html" : "png";
  const name = file.replace(/\.(html|png)$/, "");
  if (!NAME.test(name)) throw fail(400, `Page name "${name}" not allowed: use a-z, 0-9, - and _`);
  const params = { ...parseParams(query), format };
  const started = Date.now();
  const result = await render(name, params);
  ({ haConfig, haConfigAt } = result);
  result.timings.total = Date.now() - started;
  const timings = Object.entries(result.timings).map(([k, v]) => `${k}=${v}`).join(";");
  const warnings = result.warnings.join("; ");
  console.log(`page ${name} ${timings} entities=${result.ids.length}${warnings ? ` warnings: ${warnings}` : ""}`);

  const headers = {
    "Cache-Control": "no-store",
    "X-Render-Timings": timings,
    "X-Render-Entities": result.ids.join(","),
    ...(warnings && { "X-Render-Warnings": warnings }),
  };
  if (format === "html") {
    res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">${result.markup}`);
  }
  const png = Buffer.from(result.png);
  res.writeHead(200, { ...headers, "Content-Type": "image/png", "Content-Length": png.length });
  res.end(png);
}

function index(res) {
  const pages = listPages(config.pagesDir);
  const rows = pages.map((p) => `<li><a href="page/${p}">${p}</a> · <a href="page/${p}?palette=6c">6c</a> · <a href="page/${p}.html">html</a></li>`);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>ha-snapshotter</title><h1>ha-snapshotter</h1>` +
      `<p>Pages in <code>${config.pagesDir}</code>:</p><ul>${rows.join("") || "<li>none yet</li>"}</ul>`,
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const [path, search = ""] = req.url.split("?");
    if (req.method !== "GET") throw fail(405, "Only GET");
    if (path === "/healthz") return res.end("ok\n");
    if (path === "/") return index(res);
    if (config.error) throw fail(503, config.error);
    if (path.startsWith("/page/")) return await handlePage(res, path.slice("/page/".length), new URLSearchParams(search));
    throw fail(404, "Use /page/<name>, /page/<name>?palette=6c or /page/<name>.html");
  } catch (err) {
    const status = err.status ?? 500;
    console.log(`error ${status} ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(err.message + "\n");
  }
});

server.listen(config.port, () => {
  const pagesDir = resolve(config.pagesDir);
  console.log(`ha-snapshotter on :${config.port}, pages in ${pagesDir}`);
  if (!existsSync(pagesDir)) console.log(`WARNING: the pages folder ${pagesDir} does not exist yet; create it and add <name>.js pages`);
  else console.log(`pages: ${listPages(pagesDir).join(", ") || "none yet"}`);
  if (config.error) return console.log(`WARNING: ${config.error}`);
  new HassClient(config).getConfig().then(
    (c) => console.log(`connected to Home Assistant ${c.version} at ${config.haBase} (${c.location_name}, ${c.time_zone})`),
    (err) => console.log(`WARNING: ${err.message}`),
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

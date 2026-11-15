import http from "node:http";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { HassClient } from "./hass.js";
import { NAME, listPages } from "./pages.js";
import { PALETTES } from "./image.js";
import { debugPage } from "./debug.js";

const config = loadConfig();
const MAX_WAITING = 8;

let haConfig = null; // HA's /api/config, reused across renders for an hour
let haConfigAt = 0;

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => performance.timeOrigin + performance.now();

// A request's verbose log, shown on the debug page: { t, level, text } with
// t in epoch ms, from this process and the renderer process.
function newTrace() {
  const trace = { start: now(), entries: [] };
  trace.note = (text, level = "info") => trace.entries.push({ t: now(), level, text });
  return trace;
}

// `palette` is the server's own; every other query parameter is passed to the
// page as ctx.params (strings, last value wins).
function parseParams(q) {
  const palette = q.get("palette") ?? undefined;
  if (palette !== undefined && !(palette in PALETTES)) throw fail(400, `palette must be one of ${Object.keys(PALETTES).join(", ")}`);
  const params = {};
  for (const [k, v] of q) {
    if (k === "palette") continue;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) throw fail(400, `Parameter name "${k}" not allowed: use letters, digits, - and _`);
    if (v.length > 500) throw fail(400, `Parameter ${k} is longer than 500 characters`);
    params[k] = v;
  }
  if (Object.keys(params).length > 20) throw fail(400, "At most 20 parameters");
  return { palette, params };
}

// Each render runs in a child process that exits afterwards, so the renderer,
// fonts and icons are not held in memory between renders. One at a time keeps
// peak memory to one child.
let queue = Promise.resolve();
let waiting = 0;

function render(name, params, trace) {
  if (waiting >= MAX_WAITING) throw fail(503, "Too many renders queued; try again shortly");
  if (waiting) trace.note(`waiting for ${waiting} render(s) ahead in the queue`);
  waiting++;
  const job = queue.then(() => runChild(name, params, trace)).finally(() => waiting--);
  queue = job.catch(() => {});
  return job;
}

function runChild(name, params, trace) {
  trace.note("starting renderer process");
  return new Promise((resolvePromise, reject) => {
    const child = fork(new URL("./page-worker.js", import.meta.url), { serialization: "advanced" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.renderTimeoutMs);
    const done = () => clearTimeout(timer);
    child.on("message", (msg) => {
      if (msg.log) return trace.entries.push(msg.log);
      done();
      trace.note("result received from renderer process");
      msg.ok ? resolvePromise(msg) : reject(Object.assign(fail(msg.status, msg.message), { stack: msg.stack }));
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
  const kind = /\.(html|debug)$/.exec(file)?.[1] ?? "png";
  const name = file.replace(/\.(html|png|debug)$/, "");
  if (!NAME.test(name)) throw fail(400, `Page name "${name}" not allowed: use a-z, 0-9, - and _`);
  const trace = newTrace();
  trace.note(`request for ${file}${query.size ? "?" + query : ""}`);
  if (kind !== "debug") return sendPage(res, name, kind, query, trace);
  // The debug page renders the PNG too, and shows the log even when the render fails.
  let result = null;
  let error = null;
  try {
    result = await sendPage(null, name, "png", query, trace);
  } catch (err) {
    error = err;
    trace.note(err.message, "error");
  }
  res.writeHead(error?.status ?? 200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
  res.end(debugPage({ name, query, palettes: Object.keys(PALETTES), trace, result, error }));
}

// Renders a page; writes it to `res` if given, and returns the result.
async function sendPage(res, name, format, query, trace) {
  const params = { ...parseParams(query), format };
  const started = Date.now();
  const result = await render(name, params, trace);
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
  if (!res) return result;
  if (format === "html") {
    res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">${result.markup}`);
    return result;
  }
  const png = Buffer.from(result.png);
  res.writeHead(200, { ...headers, "Content-Type": "image/png", "Content-Length": png.length });
  res.end(png);
  return result;
}

function index(res) {
  const pages = listPages(config.pagesDir);
  const palettes = (p) => Object.keys(PALETTES).map((n) => `<a href="page/${p}?palette=${n}">${n}</a>`).join(" | ");
  const rows = pages.map(
    (p) => `<tr><td>${p}</td><td><a href="page/${p}">png</a></td><td>[ ${palettes(p)} ]</td><td><a href="page/${p}.html">html</a></td><td><a href="page/${p}.debug">debug</a></td></tr>`,
  );
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>hass-snapshotter</title>` +
      `<style>th,td{text-align:left;padding:2px 12px 2px 0}</style><h1>hass-snapshotter</h1>` +
      `<p>Pages in <code>${config.pagesDir}</code>:</p>` +
      (rows.length
        ? `<table><thead><tr><th>Page</th><th>Full color</th><th>Color palette</th><th>Markup</th><th>Troubleshoot</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        : "<p>None yet.</p>"),
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
    throw fail(404, "Use /page/<name>, /page/<name>?palette=6c, /page/<name>.html or /page/<name>.debug");
  } catch (err) {
    const status = err.status ?? 500;
    console.log(`error ${status} ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(err.message + "\n");
  }
});

server.listen(config.port, () => {
  const pagesDir = resolve(config.pagesDir);
  console.log(`hass-snapshotter ${process.env.SNAPSHOTTER_VERSION ?? "local"} on :${config.port}, pages in ${pagesDir}`);
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

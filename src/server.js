import http from "node:http";
import { fork } from "node:child_process";
import { loadConfig } from "./config.js";

const config = loadConfig();

// Kept here so validation doesn't load sharp/WASM; image.js holds the inks.
const PALETTES = ["bw", "bwr", "bwry", "6c"];
const DITHERS = ["none", "ordered", "burkes", "floyd_steinberg", "atkinson", "stucki", "sierra", "sierra_lite", "jarvis_judice_ninke", "dizzy"];

const pageMemory = new Map(); // page name -> entity ids it read last time
let haConfig = null; // HA's /api/config, reused across renders

const fail = (status, message) => Object.assign(new Error(message), { status });

function parseParams(q) {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(q.get("viewport") ?? "800x480");
  if (!m) throw fail(400, "viewport must be WIDTHxHEIGHT");
  const [width, height] = [Number(m[1]), Number(m[2])];
  if (width > 4000 || height > 4000) throw fail(400, "viewport is limited to 4000x4000");

  const palette = q.get("palette") ?? undefined;
  if (palette && !PALETTES.includes(palette)) throw fail(400, `palette must be one of ${PALETTES.join(", ")}`);
  const dither = (q.get("dither") ?? "none").replace(/-/g, "_");
  if (!DITHERS.includes(dither)) throw fail(400, `dither must be one of ${DITHERS.join(", ")}`);

  return { width, height, palette, dither };
}

// Each render runs in a child process that exits afterwards, so the renderer,
// fonts, icons and sharp are not held in memory between renders.
function renderInChild(name, params) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./page-worker.js", import.meta.url), { serialization: "advanced" });
    const timer = setTimeout(() => child.kill("SIGKILL"), config.renderTimeoutMs);
    child.once("message", (msg) => {
      clearTimeout(timer);
      msg.ok ? resolve(msg) : reject(fail(msg.status, msg.message));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(fail(500, `Page renderer exited (${code ?? "killed: timeout"})`));
    });
    child.send({ config, name, params, knownIds: pageMemory.get(name) ?? [], haConfig });
  });
}

async function handlePage(res, name, query) {
  const params = parseParams(query);
  const started = Date.now();
  const result = await renderInChild(name, params);
  pageMemory.set(name, result.ids);
  haConfig = result.haConfig;
  const png = Buffer.from(result.png);
  result.timings.total = Date.now() - started;
  const timings = Object.entries(result.timings).map(([k, v]) => `${k}=${v}`).join(";");
  console.log(`page ${name} entities=${result.ids.length} ${timings} bytes=${png.length}`);
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": png.length,
    "Cache-Control": "no-store",
    "X-Render-Timings": timings,
  });
  res.end(png);
}

const server = http.createServer(async (req, res) => {
  try {
    const [path, search = ""] = req.url.split("?");
    if (req.method !== "GET") throw fail(405, "Only GET");
    if (path === "/healthz") return res.end("ok\n");
    if (path.startsWith("/page/")) return await handlePage(res, path.slice("/page/".length), new URLSearchParams(search));
    throw fail(404, "Use /page/<name>?palette=6c");
  } catch (err) {
    const status = err.status ?? 500;
    console.log(`error ${status} ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(err.message + "\n");
  }
});

server.listen(config.port, () => {
  console.log(`ha-snapshotter on :${config.port}, HA ${config.haOrigin}, pages in ${config.pagesDir}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

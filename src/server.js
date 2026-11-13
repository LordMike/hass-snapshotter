import http from "node:http";
import { loadConfig } from "./config.js";
import { resolveRenderPath, PathError } from "./paths.js";
import { BrowserHost } from "./browser.js";
import { renderPage, RenderError } from "./render.js";

const config = loadConfig();
const host = new BrowserHost({
  chromiumPath: config.chromiumPath,
  idleSeconds: config.browserIdleSeconds,
  profileDir: config.profileDir,
});

// Kept here so validation doesn't load sharp/WASM; image.js holds the inks.
const PALETTES = ["bw", "bwr", "bwry", "6c"];
const DITHERS = ["none", "ordered", "burkes", "floyd_steinberg", "atkinson", "stucki", "sierra", "sierra_lite", "jarvis_judice_ninke", "dizzy"];
const MAX_QUEUE = 4;

let queue = Promise.resolve();
let queued = 0;

class ParamError extends Error {
  status = 400;
}

function parseParams(q) {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(q.get("viewport") ?? "800x480");
  if (!m) throw new ParamError("viewport must be WIDTHxHEIGHT");
  const [width, height] = [Number(m[1]), Number(m[2])];
  if (width > 4000 || height > 4000) throw new ParamError("viewport is limited to 4000x4000");

  const palette = q.get("palette") ?? undefined;
  if (palette && !PALETTES.includes(palette)) throw new ParamError(`palette must be one of ${PALETTES.join(", ")}`);
  const dither = (q.get("dither") ?? "none").replace(/-/g, "_");
  if (!DITHERS.includes(dither)) throw new ParamError(`dither must be one of ${DITHERS.join(", ")}`);

  const wait = Number(q.get("wait") ?? 0);
  if (!(wait >= 0 && wait <= 30000)) throw new ParamError("wait must be 0-30000 ms");
  const lang = q.get("lang") ?? undefined;
  if (lang && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) throw new ParamError("lang is not a language code");

  return { width, height, palette, dither, wait, lang, theme: q.get("theme") ?? undefined, dark: q.has("dark"), timeoutMs: config.readyTimeoutMs };
}

async function handleRender(req, res, rawPath, query) {
  const { path, url } = resolveRenderPath(rawPath, config);
  const params = parseParams(query);
  if (queued >= MAX_QUEUE) throw Object.assign(new Error("Render queue is full"), { status: 503 });

  // One render at a time keeps peak memory to a single browser.
  queued++;
  const job = queue.then(async () => {
    if (res.destroyed) return null; // client gave up while queued
    const started = Date.now();
    const result = await renderPage(host, config, { ...params, url }, () => queued > 1);
    if (params.palette) {
      const t = Date.now();
      const { applyPalette } = await import("./image.js");
      result.png = await applyPalette(result.png, params.palette, params.dither);
      result.timings.palette = Date.now() - t;
    }
    result.timings.total = Date.now() - started;
    return result;
  });
  queue = job.catch(() => {}).finally(() => queued--);

  const result = await job;
  if (!result) return;
  const timings = Object.entries(result.timings).map(([k, v]) => `${k}=${v}`).join(";");
  console.log(`render /${path} ${result.cold ? "cold" : "warm"} ${timings} bytes=${result.png.length}`);
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": result.png.length,
    "Cache-Control": "no-store",
    "X-Render-Timings": timings,
    "X-Render-Browser": result.cold ? "cold" : "warm",
  });
  res.end(result.png);
}

const server = http.createServer(async (req, res) => {
  try {
    const [rawPath, search = ""] = req.url.split("?");
    if (req.method !== "GET") throw Object.assign(new Error("Only GET"), { status: 405 });
    if (rawPath === "/healthz") return res.end("ok\n");
    // The raw path goes to the guard so percent-encoded tricks are seen there.
    if (rawPath.startsWith("/render/")) {
      return await handleRender(req, res, rawPath.slice("/render/".length), new URLSearchParams(search));
    }
    throw Object.assign(new Error("Use /render/<home-assistant path>?viewport=800x480"), { status: 404 });
  } catch (err) {
    const status = err.status ?? 500;
    console.log(`error ${status} ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(err.message + "\n");
  }
});

server.listen(config.port, () => {
  console.log(
    `ha-snapshotter on :${config.port}, HA ${config.haOrigin}, ` +
      `allowed paths: ${config.allowedPaths.join(", ") || "(any)"}, browser idle: ${config.browserIdleSeconds}s`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    server.close();
    await host.close();
    process.exit(0);
  });
}

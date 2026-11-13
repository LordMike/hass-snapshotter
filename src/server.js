import http from "node:http";
import { loadConfig } from "./config.js";
import { resolveRenderPath, PathError } from "./paths.js";
import { BrowserHost } from "./browser.js";
import { renderPage, RenderError } from "./render.js";
import { processImage, PALETTE_NAMES, DITHER_MODES } from "./image.js";

const config = loadConfig();
const host = new BrowserHost({ chromiumPath: config.chromiumPath, idleSeconds: config.browserIdleSeconds });

const MAX_QUEUE = 4;
let queue = Promise.resolve();
let queued = 0;

class ParamError extends Error {
  status = 400;
}

function parseParams(searchParams) {
  const get = (name) => searchParams.get(name) ?? undefined;

  const viewport = get("viewport") ?? "800x480";
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(viewport);
  if (!m) throw new ParamError(`viewport must be WIDTHxHEIGHT, got ${viewport}`);
  const [width, height] = [Number(m[1]), Number(m[2])];
  if (width > 4000 || height > 4000) throw new ParamError("viewport is limited to 4000x4000");

  const palette = get("palette");
  if (palette && !PALETTE_NAMES.includes(palette)) {
    throw new ParamError(`palette must be one of ${PALETTE_NAMES.join(", ")}`);
  }
  const dither = (get("dither") ?? "none").replace(/-/g, "_");
  if (!DITHER_MODES.includes(dither)) throw new ParamError(`dither must be one of ${DITHER_MODES.join(", ")}`);

  const rotate = Number(get("rotate") ?? 0);
  if (![0, 90, 180, 270].includes(rotate)) throw new ParamError("rotate must be 0, 90, 180 or 270");

  const wait = Number(get("wait") ?? 0);
  if (!Number.isFinite(wait) || wait < 0 || wait > 30000) throw new ParamError("wait must be 0-30000 ms");

  const lang = get("lang");
  if (lang && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) throw new ParamError("lang is not a language code");

  return {
    width,
    height,
    palette,
    dither,
    rotate,
    wait,
    lang,
    theme: get("theme"),
    dark: searchParams.has("dark"),
    timeoutMs: config.readyTimeoutMs,
  };
}

async function handleRender(res, rawPath, searchParams) {
  const { path, url } = resolveRenderPath(rawPath, config);
  const params = parseParams(searchParams);

  if (queued >= MAX_QUEUE) {
    res.writeHead(503, { "Content-Type": "text/plain", "Retry-After": "10" });
    return res.end("Render queue is full\n");
  }

  // One render at a time keeps peak memory to a single browser.
  queued++;
  const job = queue.then(async () => {
    const started = Date.now();
    const { png, timings, cold } = await renderPage(host, config, { ...params, url });
    const t0 = Date.now();
    const image = await processImage(png, params);
    timings.image = Date.now() - t0;
    timings.total = Date.now() - started;
    return { image, timings, cold };
  });
  queue = job.catch(() => {}).finally(() => queued--);

  const { image, timings, cold } = await job;
  const timingHeader = Object.entries(timings)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  console.log(`render /${path} ${cold ? "cold" : "warm"} ${timingHeader} bytes=${image.length}`);
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": image.length,
    "Cache-Control": "no-store",
    "X-Render-Timings": timingHeader,
    "X-Render-Browser": cold ? "cold" : "warm",
  });
  res.end(image);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, "http://localhost");
  try {
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      return res.end();
    }
    if (reqUrl.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok\n");
    }
    // Use the raw request path so percent-encoded tricks are seen by the guard.
    const rawPath = req.url.split("?")[0];
    if (rawPath.startsWith("/render/")) {
      return await handleRender(res, rawPath.slice("/render/".length), reqUrl.searchParams);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Use /render/<home-assistant path>?viewport=800x480\n");
  } catch (err) {
    const status = err instanceof PathError || err instanceof RenderError || err instanceof ParamError ? err.status : 500;
    console.log(`error ${status} ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(err.message + "\n");
  }
});

server.listen(config.port, () => {
  console.log(
    `ha-snapshotter listening on :${config.port}, HA ${config.haOrigin}, ` +
      `allowed paths: ${config.allowedPaths.length ? config.allowedPaths.join(", ") : "(any)"}, ` +
      `browser idle: ${config.browserIdleSeconds}s`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    server.close();
    await host.close();
    process.exit(0);
  });
}

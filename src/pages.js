// Browser-free mode: a page is a JS module that turns `hass` into HTML, and
// Takumi (a Rust HTML/CSS renderer) turns the HTML into a PNG.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { html, raw } from "./html.js";
import { recordingStates } from "./hass.js";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_PASSES = 4;

let renderer = null;

async function getRenderer(pagesDir) {
  if (renderer) return renderer;
  const { Renderer } = await import("@takumi-rs/core");
  renderer = new Renderer();
  const require = createRequire(import.meta.url);
  const roboto = join(require.resolve("@fontsource/roboto/package.json"), "..", "files");
  for (const weight of [400, 500, 700]) {
    for (const subset of ["latin", "latin-ext"]) {
      await renderer.registerFont(readFileSync(join(roboto, `roboto-${subset}-${weight}-normal.woff2`)));
    }
  }
  // Extra fonts dropped next to the pages.
  const fontsDir = join(pagesDir, "fonts");
  if (existsSync(fontsDir)) {
    for (const f of readdirSync(fontsDir)) {
      if ([".ttf", ".otf", ".woff", ".woff2"].includes(extname(f))) await renderer.registerFont(readFileSync(join(fontsDir, f)));
    }
  }
  return renderer;
}

let mdiPaths = null;
async function loadMdi() {
  mdiPaths ??= await import("@mdi/js");
  return mdiPaths;
}

// mdi("mdi:weather-cloudy", { size: 48, color: "#000" }) -> inline SVG
function mdiHelper(paths) {
  return (name, { size = 24, color = "currentColor" } = {}) => {
    const key = "mdi" + name.replace(/^mdi:/, "").replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
    const d = paths[key];
    if (!d) return raw("");
    return raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${color}" d="${d}"/></svg>`);
  };
}

async function loadPage(pagesDir, name) {
  if (!NAME.test(name)) throw Object.assign(new Error(`Page name not allowed: ${name}`), { status: 400 });
  const file = join(pagesDir, `${name}.js`);
  if (!existsSync(file)) throw Object.assign(new Error(`No page ${name}.js in ${pagesDir}`), { status: 404 });
  // Cache-bust on change so edited pages are picked up without a restart.
  const mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
  if (typeof mod.default !== "function") throw Object.assign(new Error(`${name}.js has no default export`), { status: 500 });
  return mod;
}

/**
 * Renders a page module to PNG.
 * @param {string[]} knownIds entities the page read last time, fetched up front
 * @returns {Promise<{png: Buffer, timings: Record<string, number>, ids: string[]}>}
 */
export async function renderPageModule({ pagesDir, client }, name, { width, height }, knownIds = []) {
  const timings = {};
  let last = Date.now();
  const mark = (k) => {
    const now = Date.now();
    timings[k] = (timings[k] ?? 0) + now - last;
    last = now;
  };

  const page = await loadPage(pagesDir, name);
  const [r, paths, config] = await Promise.all([getRenderer(pagesDir), loadMdi(), client.getConfig()]);
  mark("load");

  const fetched = {};
  await client.fetchStates(knownIds, fetched);
  mark("fetch");

  const ctx = { html, raw, mdi: mdiHelper(paths), now: new Date(), timeZone: config.time_zone };
  let markup;
  for (let pass = 1; ; pass++) {
    const missing = new Set();
    const hass = { states: recordingStates(fetched, missing), config, language: config.language };
    let error = null;
    try {
      markup = String(page.default(hass, ctx));
    } catch (err) {
      error = err; // often just data that isn't fetched yet
    }
    mark("template");
    if (missing.size === 0 || pass === MAX_PASSES) {
      if (error) throw error;
      break;
    }
    await client.fetchStates(missing, fetched);
    mark("fetch");
  }
  const size = page.size ?? [width, height];
  const png = await r.render(markup, { width: size[0], height: size[1] });
  mark("render");
  return { png, timings, ids: Object.keys(fetched) };
}

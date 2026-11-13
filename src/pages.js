// A page is a JS module that turns `hass` into HTML, and
// Takumi (a Rust HTML/CSS renderer) turns the HTML into a PNG.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { html, raw, Safe } from "./html.js";
import { recordingStates } from "./hass.js";

export const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_PASSES = 4;
const require = createRequire(import.meta.url);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function listPages(pagesDir) {
  if (!existsSync(pagesDir)) return [];
  return readdirSync(pagesDir)
    .filter((f) => f.endsWith(".js") && NAME.test(f.slice(0, -3)))
    .map((f) => f.slice(0, -3))
    .sort();
}

async function getRenderer(pagesDir) {
  const { Renderer } = await import("@takumi-rs/core");
  const renderer = new Renderer();
  const roboto = join(require.resolve("@fontsource/roboto/package.json"), "..", "files");
  const fonts = [400, 500, 700].flatMap((w) => ["latin", "latin-ext"].map((s) => join(roboto, `roboto-${s}-${w}-normal.woff2`)));
  // Extra fonts dropped next to the pages.
  const fontsDir = join(pagesDir, "fonts");
  if (existsSync(fontsDir)) {
    for (const f of readdirSync(fontsDir)) {
      if ([".ttf", ".otf", ".woff", ".woff2"].includes(extname(f))) fonts.push(join(fontsDir, f));
    }
  }
  await Promise.all(
    fonts.map((f) =>
      renderer.registerFont(readFileSync(f)).catch((err) => {
        throw fail(500, `Font ${f} could not be loaded: ${err.message}`);
      }),
    ),
  );
  return renderer;
}

// mdi("mdi:weather-cloudy", { size: 48, color: "#000" }) -> inline SVG.
// The icon set (2.8 MB) is only loaded if a page uses an icon.
function mdiHelper(warnings) {
  let paths = null;
  return (name, { size = 24, color = "currentColor" } = {}) => {
    paths ??= require("@mdi/js");
    const key = "mdi" + String(name).replace(/^mdi:/, "").replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
    const d = paths[key];
    if (!d) {
      warnings.add(`unknown icon ${name}`);
      return raw("");
    }
    return raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${color}" d="${d}"/></svg>`);
  };
}

async function loadPage(pagesDir, name) {
  const file = resolve(pagesDir, `${name}.js`);
  if (!existsSync(file)) {
    const available = listPages(pagesDir);
    throw fail(404, `No page ${name}.js in ${pagesDir}. Available: ${available.join(", ") || "none"}`);
  }
  // Cache-bust on change so edited pages are picked up without a restart.
  const mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`).catch((err) => {
    throw fail(500, `${name}.js could not be loaded: ${err.message}${lineOf(err, name)}`);
  });
  if (typeof mod.default !== "function") throw fail(500, `${name}.js must \`export default function render(hass, ctx)\``);
  if (mod.params !== undefined && !(Array.isArray(mod.params) && mod.params.every((p) => typeof p === "string"))) {
    throw fail(500, `${name}.js: \`export const params\` must be a list of parameter names`);
  }
  return mod;
}

// The page's size: `export const size = [w, h]`, or a function of the URL
// parameters returning one. Default 800x480.
function pageSize(page, name, params) {
  let size = page.size ?? [800, 480];
  if (typeof size === "function") {
    try {
      size = size(params);
    } catch (err) {
      throw fail(400, `${name}.js size(params) failed${lineOf(err, name)}: ${err.message}`);
    }
  }
  if (!(Array.isArray(size) && size.length === 2 && size.every((n) => Number.isInteger(n) && n > 0 && n <= 4000))) {
    throw fail(500, `${name}.js: size must be [width, height] in whole pixels up to 4000`);
  }
  return size;
}

// A page that declares `export const params = [...]` gets typos rejected.
function checkParams(page, name, params) {
  if (!page.params) return;
  const unknown = Object.keys(params).filter((k) => !page.params.includes(k));
  if (unknown.length) {
    throw fail(400, `${name} does not take parameter ${unknown.map((k) => `"${k}"`).join(", ")}; it takes: ${page.params.join(", ") || "none"} (and palette)`);
  }
}

// " (line N)" from an error's stack, for the page file.
function lineOf(err, name) {
  const m = new RegExp(`${name}\\.js(?:\\?[^:]*)?:(\\d+)`).exec(err?.stack ?? "");
  return m ? ` (line ${m[1]})` : "";
}

/**
 * Renders a page module.
 * @param {"png"|"html"} format "html" returns the markup instead of an image
 * @returns {Promise<{png?: Buffer, markup?: string, timings: Record<string, number>, ids: string[], warnings: string[]}>}
 */
export async function renderPageModule({ pagesDir, client }, name, { palette, format, params = {} }) {
  const timings = {};
  let last = Date.now();
  const mark = (k) => {
    const now = Date.now();
    timings[k] = (timings[k] ?? 0) + now - last;
    last = now;
  };

  const page = await loadPage(pagesDir, name);
  checkParams(page, name, params);
  const [w, h] = pageSize(page, name, params);
  // States are fetched in parallel with loading the renderer and fonts.
  const [r, config] = await Promise.all([
    format === "html" ? null : getRenderer(pagesDir),
    client.getConfig(),
    client.fetchStates([], {}),
  ]);
  mark("load");

  const fetched = Object.create(null);

  const warnings = new Set();
  const ctx = {
    html,
    raw,
    mdi: mdiHelper(warnings),
    now: new Date(),
    timeZone: config.time_zone,
    locale: config.language,
    params: Object.freeze({ ...params }),
    size: [w, h],
  };
  let markup;
  let read;
  for (let pass = 1; ; pass++) {
    const missing = new Set();
    read = new Set();
    const hass = { states: recordingStates(fetched, missing, read), config, language: config.language };
    let error = null;
    try {
      const out = await page.default(hass, ctx);
      if (typeof out !== "string" && !(out instanceof Safe)) {
        throw new Error(`render() returned ${out === undefined ? "nothing (missing return?)" : typeof out}; return an html\`...\` string`);
      }
      markup = String(out);
    } catch (err) {
      error = err; // often just data that isn't fetched yet
    }
    mark("template");
    if (missing.size === 0) {
      if (error) {
        const unknown = [...read].filter((id) => fetched[id] === null);
        throw fail(500, `${name}.js${lineOf(error, name)}: ${error.message}` + (unknown.length ? ` (entities not found in HA: ${unknown.join(", ")})` : ""));
      }
      break;
    }
    if (pass === MAX_PASSES) throw fail(500, `${name}.js still reads new entities after ${MAX_PASSES} passes: ${[...missing].join(", ")}`);
    await client.fetchStates(missing, fetched);
    mark("fetch");
  }
  for (const id of read) if (fetched[id] === null) warnings.add(`entity not found: ${id}`);
  const result = { timings, ids: [...read], warnings: [...warnings] };
  if (format === "html") return { ...result, markup };

  if (!palette) {
    result.png = await r.render(markup, { width: w, height: h });
    mark("render");
    return result;
  }
  const rgba = await r.render(markup, { width: w, height: h, format: "raw" });
  mark("render");
  const { applyPalette } = await import("./image.js");
  result.png = applyPalette(rgba, w, h, palette);
  mark("palette");
  return result;
}

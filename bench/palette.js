// Benchmarks applyPalette: `node bench/palette.js [--save]`.
// Renders a dashboard-like page and a full-frame gradient with Takumi at a
// small and a large size, plus copies already in each palette, then times
// every palette on each. Each case runs in a fresh process: the first call is
// "cold" (as in production, where every render is a new process), the median
// of the later calls is "warm"; each case runs in REPEAT processes and the
// median is kept. Images go to .tmp/bench/. The decoded pixels of every output
// are compared with the run saved by --save, so optimisations can't change
// the image.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { applyPalette, PALETTES } from "../src/image.js";

const OUT = ".tmp/bench";
const SIZES = { small: [296, 128], medium: [800, 480], large: [1600, 1200] };
const WARM_RUNS = 9;
const REPEAT = 3;
const median = (xs) => xs.toSorted((a, b) => a - b)[xs.length >> 1];

const child = process.argv[2] === "case";
if (child) {
  // Child: time one image on one palette.
  const [, , , file, w, h, palette] = process.argv;
  const src = readFileSync(file);
  const times = [];
  for (let i = 0; i <= WARM_RUNS; i++) {
    const rgba = new Uint8Array(src); // a fresh copy, as each render gets from Takumi
    const t = performance.now();
    applyPalette(rgba, +w, +h, palette);
    times.push(performance.now() - t);
  }
  const warm = median(times.slice(1));
  console.log(JSON.stringify({ cold: times[0], warm }));
}

const markup = (w, h) => {
  const f = h / 480; // scale everything with the height
  const px = (n) => `${Math.round(n * f)}px`;
  const bar = (color, pct) => `<div style="height:${px(14)};width:${pct}%;background:${color};border-radius:${px(7)}"></div>`;
  return `<div style="width:${w}px;height:${h}px;background:#fff;display:flex;flex-direction:column;padding:${px(16)};gap:${px(10)};font-family:Roboto;color:#000">
  <div style="display:flex;justify-content:space-between;align-items:baseline">
    <div style="font-size:${px(96)};font-weight:700">21:47</div>
    <div style="font-size:${px(28)}">søndag 15. november</div>
  </div>
  <div style="display:flex;gap:${px(10)}">
    <div style="background:#ff0000;color:#fff;padding:${px(6)} ${px(12)};border-radius:${px(8)};font-size:${px(22)}">Affald i morgen</div>
    <div style="background:#ffff00;padding:${px(6)} ${px(12)};border-radius:${px(8)};font-size:${px(22)}">Vindue åbent: Køkken</div>
    <div style="background:#0000ff;color:#fff;padding:${px(6)} ${px(12)};border-radius:${px(8)};font-size:${px(22)}">EV 74%</div>
  </div>
  <div style="font-size:${px(16)};line-height:1.3">Small text: 07:30 Tandlæge · 12:00 Frokost med Anna · 16:15 Hente børn · 19:00 Fodbold · 21:00 Opvaskemaskine færdig</div>
  ${bar("#00ff00", 80)}${bar("#ff0000", 35)}${bar("#888", 60)}
  <svg width="${w - 32 * f}" height="${px(90)}" viewBox="0 0 100 30" preserveAspectRatio="none">
    <polyline fill="none" stroke="#000" stroke-width="0.6" points="0,25 10,20 20,22 30,12 40,15 50,8 60,10 70,4 80,9 90,6 100,12"/>
    <polyline fill="none" stroke="#0000ff" stroke-width="0.6" points="0,28 10,26 20,27 30,22 40,24 50,18 60,21 70,16 80,19 90,15 100,20"/>
  </svg>
</div>`;
};
// Worst case: no pixel is an exact ink.
const gradient = (w, h) =>
  `<div style="width:${w}px;height:${h}px;background-image:linear-gradient(135deg,#f08 0%,#3cf 50%,#fc3 100%)"></div>`;

// The palette and pixel rows of our own indexed PNG (filter 0 rows).
function decode(png) {
  let pos = 8;
  let plte;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "PLTE") plte = data;
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  return { plte, rows: inflateSync(Buffer.concat(idat)) };
}

// Decodes our own indexed PNG back into RGBA, giving an image whose pixels
// are all exactly in the palette (8-bit indices).
function indexedToRgba(png, w, h) {
  const { plte, rows } = decode(png);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = rows[y * (w + 1) + 1 + x];
      rgba.set([plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2], 255], (y * w + x) * 4);
    }
  }
  return rgba;
}

async function renderer() {
  const { Renderer } = await import("@takumi-rs/core");
  const r = new Renderer();
  const require = createRequire(import.meta.url);
  const dir = join(require.resolve("@fontsource/roboto/package.json"), "..", "files");
  await Promise.all([400, 700].flatMap((w) => ["latin", "latin-ext"].map((s) => r.registerFont(readFileSync(join(dir, `roboto-${s}-${w}-normal.woff2`))))));
  return r;
}

// No process.exit in the child: on Windows it can trip a libuv assert while
// V8 still compiles WebAssembly in the background.
if (!child) await main();

async function main() {
  mkdirSync(OUT, { recursive: true });
  const r = await renderer();
  const palettes = Object.keys(PALETTES);
  const results = [];
  const time = (file, w, h, palette) => {
    const runs = Array.from({ length: REPEAT }, () =>
      JSON.parse(execFileSync(process.execPath, [import.meta.filename, "case", file, w, h, palette], { encoding: "utf8" })),
    );
    return { cold: median(runs.map((r) => r.cold)), warm: median(runs.map((r) => r.warm)) };
  };
  const hashes = {};
  const hash = (name, png) => {
    const { plte, rows } = decode(png);
    hashes[name] = createHash("sha1").update(plte).update(rows).digest("hex");
  };

  for (const [size, [w, h]] of Object.entries(SIZES)) {
    for (const [kind, make] of Object.entries({ ui: markup, gradient })) {
      const rgba = new Uint8Array(await r.render(make(w, h), { width: w, height: h, format: "raw" }));
      const file = join(OUT, `${kind}-${size}.rgba`);
      writeFileSync(file, rgba);
      writeFileSync(join(OUT, `${kind}-${size}.png`), await r.render(make(w, h), { width: w, height: h }));
      for (const palette of palettes) {
        const png = applyPalette(new Uint8Array(rgba), w, h, palette);
        writeFileSync(join(OUT, `${kind}-${size}-${palette}.png`), png);
        hash(`${kind}-${size}-${palette}`, png);
        results.push({ size, image: kind, palette, ...time(file, w, h, palette) });
        // The same picture, already in the palette.
        if (kind === "ui") {
          const exactFile = join(OUT, `ui-${size}-in-${palette}.rgba`);
          const exact = indexedToRgba(png, w, h);
          writeFileSync(exactFile, exact);
          hash(`ui-${size}-in-${palette}`, applyPalette(exact, w, h, palette));
          results.push({ size, image: "ui, already in palette", palette, ...time(exactFile, w, h, palette) });
        }
      }
    }
  }

  const fmt = (n) => n.toFixed(1).padStart(7);
  console.log(`Node ${process.version}, ${process.arch}; ms per applyPalette call (cold = first call in a fresh process, warm = median of ${WARM_RUNS})`);
  console.log(`${"size".padEnd(8)}${"image".padEnd(25)}${"palette".padEnd(9)}   cold    warm`);
  for (const x of results) console.log(`${x.size.padEnd(8)}${x.image.padEnd(25)}${x.palette.padEnd(9)}${fmt(x.cold)} ${fmt(x.warm)}`);

  const total = (pick, key) => results.filter(pick).reduce((a, x) => a + x[key], 0);
  const color = (x) => !x.palette.startsWith("gray");
  for (const [label, pick] of [["color palettes", color], ["gray palettes", (x) => !color(x)]]) {
    console.log(`total ${label}: cold ${total(pick, "cold").toFixed(0)} ms, warm ${total(pick, "warm").toFixed(0)} ms`);
  }

  const saved = join(OUT, "hashes.json");
  if (process.argv.includes("--save")) {
    writeFileSync(saved, JSON.stringify(hashes, null, 1));
    console.log(`saved output hashes to ${saved}`);
  } else if (existsSync(saved)) {
    const before = JSON.parse(readFileSync(saved, "utf8"));
    const changed = Object.keys(hashes).filter((k) => hashes[k] !== before[k]);
    console.log(changed.length ? `OUTPUT CHANGED: ${changed.join(", ")}` : "output identical to the saved run");
    if (changed.length) process.exitCode = 1;
  }
}

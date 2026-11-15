// Maps rendered RGBA pixels onto an e-paper panel's inks and writes an indexed PNG.
import { readFileSync } from "node:fs";

const INKS = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  yellow: [255, 255, 0],
  blue: [0, 0, 255],
  green: [0, 255, 0],
};

const INK_PALETTES = {
  bw: ["white", "black"],
  bwr: ["white", "black", "red"],
  bwry: ["white", "black", "red", "yellow"],
  "6c": ["white", "black", "red", "yellow", "blue", "green"],
};

// Greyscale panels: evenly spaced grey levels from black to white.
const GRAY_LEVELS = { gray4: 4, gray16: 16 };

export const PALETTES = { ...INK_PALETTES, ...GRAY_LEVELS };

// The pixel loops and the PNG writer (deflate included) are Rust, built for
// WebAssembly with SIMD (native/palette, `sh native/palette/build.sh`);
// compiled on first use. It holds one buffer, sized for the largest image so
// far: up to 16 colour words at +0, the RGBA pixels at +PIXELS (64 colour bytes
// and SCAN_LEAD in lib.rs).
const PIXELS = 128;
let kernel = null;
function palettes() {
  if (kernel) return kernel;
  const file = new URL("./palette.wasm", import.meta.url);
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    throw new Error(`${err.code === "ENOENT" ? "src/palette.wasm is missing" : err.message}: build it with \`sh native/palette/build.sh\``);
  }
  kernel = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
  return kernel;
}

/**
 * Maps RGBA pixels onto a panel palette and returns an indexed PNG whose
 * pixels are the panel's exact colours, so the display can map them 1:1.
 * No dithering: pages are flat UI, drawn in the panel's colours.
 *
 * Transparency is flattened onto white (a page without a background is
 * transparent, which would read as black). Greyscale panels take the nearest
 * grey level by luminance; anti-aliased edges stay soft greys instead of being
 * cut to black or white.
 *
 * Colour panels: pixels that are exactly an ink keep it. Anti-aliased edges
 * (pixels within 2 px of an exact ink) take the nearest of black, white and
 * those inks, so black text on yellow never gains red fringes. Next to a thin
 * stroke, an edge pixel joins the stroke from about 30% coverage instead of
 * 50%, so small text keeps its strokes: the most common nearby ink is taken as
 * the background and its squared distance is weighted by 5. A stroke counts as
 * thin when the other ink has fewer than 6 exact pixels in the 5x5 window;
 * edges of thick shapes (big digits, bars) use a plain 50% cut, which keeps
 * curves clean. Other colours take the nearest ink overall.
 */
export function applyPalette(rgba, width, height, name, log = () => {}) {
  // Each part's time goes to the debug page's log.
  const steps = [];
  let last = performance.now();
  const step = (label) => {
    const now = performance.now();
    steps.push(`${label} ${(now - last).toFixed(1)} ms`);
    last = now;
  };
  const compile = !kernel;
  const k = palettes();
  if (compile) step("wasm compiled");
  // Room for everything, the PNG included, so memory does not grow (and `mem`
  // stays valid) until the next prepare.
  const base = k.prepare(width, height);
  step("buffer");
  const mem = new Uint8Array(k.memory.buffer);
  mem.set(rgba.subarray(0, width * height * 4), base + PIXELS);
  step("pixels copied");
  const levels = GRAY_LEVELS[name];
  const colors = levels
    ? Array.from({ length: levels }, (_, i) => Array(3).fill(Math.round((i * 255) / (levels - 1))))
    : INK_PALETTES[name].map((ink) => INKS[ink]);
  mem.set(colors.flatMap(([r, g, b]) => [r, g, b, 255]), base);
  const rows = levels ? k.map_gray(width, height, levels) : k.map_inks(width, height, colors.length);
  step("mapped");
  // The kernel writes the PNG after the scanlines; copy it out of its memory.
  const at = rows + (width + 1) * height;
  const png = Buffer.from(mem.subarray(at, at + k.png(width, height, colors.length)));
  step("PNG");
  log(`palette ${name}: ${steps.join(", ")}`);
  return png;
}

// Maps rendered RGBA pixels onto an e-paper panel's inks and writes an indexed PNG.
import { readFileSync } from "node:fs";
import { deflateSync, crc32, constants } from "node:zlib";

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

// The pixel loops are Rust, built for WebAssembly with SIMD (native/palette,
// `sh native/palette/build.sh`); compiled on first use. It holds one buffer, sized for
// the largest image so far.
let kernel = null;
function palettes() {
  kernel ??= new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("./palette.wasm", import.meta.url)))).exports;
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
export function applyPalette(rgba, width, height, name) {
  const k = palettes();
  const base = k.prepare(width, height);
  const mem = new Uint8Array(k.memory.buffer);
  mem.set(rgba.subarray(0, width * height * 4), base + 32);
  let inks;
  let rows;
  if (name in GRAY_LEVELS) {
    const levels = GRAY_LEVELS[name];
    inks = Array.from({ length: levels }, (_, i) => Array(3).fill(Math.round((i * 255) / (levels - 1))));
    rows = k.map_gray(width, height, levels);
  } else {
    inks = INK_PALETTES[name].map((ink) => INKS[ink]);
    mem.set(inks.flatMap(([r, g, b]) => [r, g, b, 255]), base);
    rows = k.map_inks(width, height, inks.length);
  }
  return indexedPng(mem.subarray(rows, rows + (width + 1) * height), width, height, inks);
}

// Minimal 8-bit indexed PNG: IHDR, PLTE with the inks, one IDAT, IEND.
// `rows` are the scanlines: filter byte 0, then one index per pixel.
function indexedPng(rows, width, height, inks) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8); // bit depth 8, colour type 3 (palette)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(inks.flat())),
    // Run-length matching only: flat UI rows compress 6-7x faster than with
    // the default, for files about a quarter larger.
    chunk("IDAT", deflateSync(rows, { strategy: constants.Z_RLE })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Maps rendered RGBA pixels onto an e-paper panel's inks and writes an indexed PNG.
import { deflateSync, crc32 } from "node:zlib";

const INKS = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  yellow: [255, 255, 0],
  blue: [0, 0, 255],
  green: [0, 255, 0],
};

export const PALETTES = {
  bw: ["white", "black"],
  bwr: ["white", "black", "red"],
  bwry: ["white", "black", "red", "yellow"],
  "6c": ["white", "black", "red", "yellow", "blue", "green"],
};

/**
 * Maps RGBA pixels onto a panel palette and returns an indexed PNG whose
 * pixels are the pure ink colours, so the display can map them 1:1.
 * No dithering: pages are flat UI, drawn in the panel's colours.
 */
export function applyPalette(rgba, width, height, name) {
  const inks = PALETTES[name].map((ink) => INKS[ink]);
  // Takumi's raw output is straight RGBA; flatten transparency onto white
  // (a page without a background is transparent, which would read as black).
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a === 255) continue;
    for (let c = i - 3; c < i; c++) rgba[c] = Math.round((rgba[c] * a + 255 * (255 - a)) / 255);
    rgba[i] = 255;
  }
  return indexedPng(mapToInks(rgba, width, height, inks), width, height, inks);
}

// Next to a thin stroke, an edge pixel joins the stroke from about 30% coverage
// instead of 50%, so small text keeps its strokes: the background ink's squared
// distance is weighted by 5 (stroke wins when (1-c) < 2.24c). A stroke counts as
// thin when the other ink has fewer than THICK exact pixels in the 5x5 window;
// edges of thick shapes (big digits, bars) use a plain 50% cut, which keeps
// curves clean.
const BACKGROUND_WEIGHT = 5;
const THICK = 6;

/**
 * Pixels that are exactly an ink keep it. Anti-aliased edges (pixels within
 * 2 px of an exact ink) take the nearest of black, white and those inks, so
 * black text on yellow never gains red fringes; the most common nearby ink is
 * taken as the background and counts as further away, so thin strokes survive.
 * Other colours take the nearest ink overall.
 */
function mapToInks(data, width, height, inks) {
  const n = width * height;
  const out = new Uint8Array(n);
  const exact = new Int8Array(n).fill(-1);
  const key = (r, g, b) => (r << 16) | (g << 8) | b;
  const inkOf = new Map(inks.map(([r, g, b], i) => [key(r, g, b), i]));
  for (let p = 0; p < n; p++) exact[p] = inkOf.get(key(data[p * 4], data[p * 4 + 1], data[p * 4 + 2])) ?? -1;
  const baseMask = (1 << inkOf.get(key(0, 0, 0))) | (1 << inkOf.get(key(255, 255, 255)));

  const nearest = (p, mask, background = -1) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < inks.length; i++) {
      if (mask && !(mask & (1 << i))) continue;
      const dr = data[p * 4] - inks[i][0];
      const dg = data[p * 4 + 1] - inks[i][1];
      const db = data[p * 4 + 2] - inks[i][2];
      const d = (dr * dr + dg * dg + db * db) * (i === background ? BACKGROUND_WEIGHT : 1);
      if (d < bestDist) [best, bestDist] = [i, d];
    }
    return best;
  };
  const counts = new Uint16Array(inks.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (exact[p] >= 0) {
        out[p] = exact[p];
        continue;
      }
      let mask = baseMask;
      let edge = false;
      counts.fill(0);
      for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
        for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) {
          const e = exact[yy * width + xx];
          if (e >= 0) {
            mask |= 1 << e;
            counts[e]++;
            edge = true;
          }
        }
      }
      let background = -1;
      let max = 0;
      let second = 0;
      for (let i = 0; i < inks.length; i++) {
        if (counts[i] > max) [background, max, second] = [i, counts[i], max];
        else if (counts[i] > second) second = counts[i];
      }
      if (second >= THICK) background = -1; // edge of a thick shape: plain 50% cut
      out[p] = edge ? nearest(p, mask, background) : nearest(p, 0);
    }
  }
  return out;
}

// Minimal 8-bit indexed PNG: IHDR, PLTE with the inks, one IDAT, IEND.
function indexedPng(indices, width, height, inks) {
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

  const rows = Buffer.alloc((width + 1) * height); // each row: filter byte 0, then indices
  for (let y = 0; y < height; y++) rows.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(inks.flat())),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

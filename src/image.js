// Maps rendered RGBA pixels onto a panel palette and writes an indexed PNG.
import { deflateSync, crc32 } from "node:zlib";
import { ditherImage, Palette } from "@opendisplay/epaper-dithering";

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

const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
const built = new Map();

// Each ink is named with its exact nominal colour, so pixels that already use
// it stay solid and undithered.
function palette(name) {
  if (!built.has(name)) {
    const inks = PALETTES[name].map((ink) => INKS[ink]);
    const pal = Palette.fromSrgb(
      PALETTES[name].map((ink, i) => {
        const [r, g, b] = inks[i];
        return { rgb: { r, g, b }, name: ink, nominal: hex(inks[i]) };
      }),
    );
    built.set(name, { inks, pal });
  }
  return built.get(name);
}

/**
 * Maps RGBA pixels onto a panel palette and returns an indexed PNG. Output
 * pixels are the pure ink colours (not preview colours), so the display can
 * map them 1:1.
 */
export function applyPalette(rgba, width, height, name, dither) {
  const { inks, pal } = palette(name);
  if (dither === "none") return indexedPng(mapToNeighbourInks(rgba, width, height, inks), width, height, inks);

  const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
  const { indices } = ditherImage({ width, height, data: pixels }, pal, { mode: dither });
  return indexedPng(indices, width, height, inks);
}

/**
 * Mapping without dithering, for UI-like pages. Pixels that are exactly an ink
 * keep it. Any other pixel (anti-aliased edges) takes the nearest of black,
 * white and the exact inks within 2 px, so black text on yellow never gains
 * red fringes.
 */
function mapToNeighbourInks(data, width, height, inks) {
  const n = width * height;
  const out = new Uint8Array(n);
  const exact = new Int8Array(n).fill(-1);
  const key = (r, g, b) => (r << 16) | (g << 8) | b;
  const inkOf = new Map(inks.map(([r, g, b], i) => [key(r, g, b), i]));
  for (let p = 0; p < n; p++) exact[p] = inkOf.get(key(data[p * 4], data[p * 4 + 1], data[p * 4 + 2])) ?? -1;
  const baseMask = (1 << inkOf.get(key(0, 0, 0))) | (1 << inkOf.get(key(255, 255, 255)));

  const nearest = (p, mask) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < inks.length; i++) {
      if (mask && !(mask & (1 << i))) continue;
      const dr = data[p * 4] - inks[i][0];
      const dg = data[p * 4 + 1] - inks[i][1];
      const db = data[p * 4 + 2] - inks[i][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) [best, bestDist] = [i, d];
    }
    return best;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (exact[p] >= 0) {
        out[p] = exact[p];
        continue;
      }
      // Black and white are always candidates: thin text may have no exact-ink core.
      let mask = baseMask;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
        for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) {
          const e = exact[yy * width + xx];
          if (e >= 0) mask |= 1 << e;
        }
      }
      out[p] = nearest(p, mask);
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
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

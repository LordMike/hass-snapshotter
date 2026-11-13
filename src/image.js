// Loaded only when a palette is requested, so sharp and the WASM ditherer cost
// nothing between renders.
import sharp from "sharp";
import { ditherImage, Palette } from "@opendisplay/epaper-dithering";

sharp.cache(false);
sharp.concurrency(1);

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
 * Maps a screenshot onto a panel palette. Output pixels are the pure ink
 * colours (not preview colours), so the display can map them 1:1.
 */
export async function applyPalette(png, name, dither) {
  const { inks, pal } = palette(name);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (dither === "none") return encode(mapToNeighbourInks(data, info.width, info.height, inks), inks, info);

  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  const { indices } = ditherImage({ width: info.width, height: info.height, data: pixels }, pal, { mode: dither });
  return encode(indices, inks, info);
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

function encode(indices, inks, info) {
  const rgb = Buffer.alloc(indices.length * 3);
  for (let i = 0; i < indices.length; i++) rgb.set(inks[indices[i]], i * 3);
  return (
    sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
      // colours must stay above the ink count: at exactly inks.length the
      // quantiser merges inks (white + yellow became pale yellow).
      .png({ palette: true, colours: 256, dither: 0, compressionLevel: 9 })
      .toBuffer()
  );
}

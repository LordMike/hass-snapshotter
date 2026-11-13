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
  const { indices } = ditherImage(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) },
    pal,
    { mode: dither },
  );

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

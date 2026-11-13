import sharp from "sharp";
import { ditherImage, Palette } from "@opendisplay/epaper-dithering";

const INKS = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  yellow: [255, 255, 0],
  blue: [0, 0, 255],
  green: [0, 255, 0],
};

// Idealised panel palettes. Each ink is named with its exact nominal colour,
// so pixels that already use that colour stay solid and undithered.
const PALETTE_INKS = {
  bw: ["white", "black"],
  bwr: ["white", "black", "red"],
  bwry: ["white", "black", "red", "yellow"],
  "6c": ["white", "black", "red", "yellow", "blue", "green"],
};

const hex = ([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

const palettes = new Map(
  Object.entries(PALETTE_INKS).map(([name, inks]) => [
    name,
    {
      inks: inks.map((ink) => INKS[ink]),
      palette: Palette.fromSrgb(
        inks.map((ink) => {
          const [r, g, b] = INKS[ink];
          return { rgb: { r, g, b }, name: ink, nominal: hex(INKS[ink]) };
        }),
      ),
    },
  ]),
);

export const PALETTE_NAMES = [...palettes.keys()];
export const DITHER_MODES = [
  "none",
  "ordered",
  "burkes",
  "floyd_steinberg",
  "atkinson",
  "stucki",
  "sierra",
  "sierra_lite",
  "jarvis_judice_ninke",
  "dizzy",
];

/**
 * Optionally rotates, then maps the screenshot onto a panel palette.
 * Output pixels use the pure ink colours (not preview colours), so the display
 * driver can map them 1:1. Without a palette the PNG is returned as-is.
 */
export async function processImage(png, { palette, dither, rotate }) {
  if (!palette && !rotate) return png;

  let img = sharp(png);
  if (rotate) img = img.rotate(rotate);
  if (!palette) return img.png().toBuffer();

  const { inks, palette: pal } = palettes.get(palette);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = ditherImage(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) },
    pal,
    { mode: dither },
  );

  const rgb = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0; i < result.indices.length; i++) {
    const [r, g, b] = inks[result.indices[i]];
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
    .png({ palette: true, colours: inks.length, dither: 0, compressionLevel: 9 })
    .toBuffer();
}

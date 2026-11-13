import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { applyPalette } from "../src/image.js";

// Decodes the indexed PNG applyPalette writes into [r,g,b] per pixel.
function decode(png) {
  let pos = 8;
  let width, palette;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") width = data.readUInt32BE(0);
    if (type === "PLTE") palette = [...Array(len / 3)].map((_, i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const pixels = [];
  for (let r = 0; r < rows.length / (width + 1); r++) {
    for (let x = 0; x < width; x++) pixels.push(palette[rows[r * (width + 1) + 1 + x]]);
  }
  return pixels;
}

const image = (pixels) => Buffer.from(pixels.flat());

test("transparent pixels become white, not black", () => {
  const out = decode(applyPalette(image([[0, 0, 0, 0], [255, 0, 0, 128]]), 2, 1, "6c"));
  assert.deepEqual(out[0], [255, 255, 255]);
});

test("solid off-palette colours take the nearest ink", () => {
  const orange = [255, 165, 0, 255];
  const out = decode(applyPalette(image(Array(25).fill(orange)), 5, 5, "6c"));
  assert.ok(out.every(([r, g, b]) => r === 255 && b === 0 && (g === 0 || g === 255)), JSON.stringify(out[12]));
});

test("thin strokes keep partly covered edge pixels", () => {
  const white = [255, 255, 255, 255];
  const black = [0, 0, 0, 255];
  const third = [170, 170, 170, 255]; // ~1/3 black coverage on white
  const sixth = [213, 213, 213, 255]; // ~1/6 coverage: stays background
  const out = decode(applyPalette(image([white, white, white, sixth, third, black]), 6, 1, "6c"));
  assert.deepEqual(out[4], [0, 0, 0]);
  assert.deepEqual(out[3], [255, 255, 255]);
});

test("anti-aliased black-on-yellow edges never become red", () => {
  const yellow = [255, 255, 0, 255];
  const black = [0, 0, 0, 255];
  const olive = [128, 128, 0, 255];
  const out = decode(applyPalette(image([yellow, yellow, olive, black, black]), 5, 1, "6c"));
  assert.ok(!out.some(([r, g, b]) => r === 255 && g === 0 && b === 0), JSON.stringify(out));
});

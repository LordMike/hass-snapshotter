// The palette mapping's pixel loops and the PNG writer, built for WebAssembly
// with SIMD128 (`sh native/palette/build.sh`). src/image.js keeps the rules'
// description, writes the colours and the pixels into the buffer from
// `prepare`, and calls `map_inks` or `map_gray`, which return PNG scanlines
// (filter byte 0, then one index per pixel), then `png`, which writes the
// file after them.
//
// The mappers make one pass down the image, 16 pixels at a time, and write
// the scanlines over the pixels they came from: a scanline is a quarter of
// its pixels' size and starts SCAN_LEAD bytes before them, so writing never
// catches up with reading. Loops run past the end of a row to the next
// multiple of 16; what they write there is overwritten by the next row or
// lands in padding.
#![no_std]
use core::arch::wasm32::*;

mod deflate;
mod png;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

// The buffer is the memory after the module's own data, grown as needed and
// kept between calls: up to 16 colour words, the scanlines with the pixels
// SCAN_LEAD bytes in, padding, then 5 rows of per-pixel exact inks (`Ring`).
// The PNG goes after the scanlines, over pixels that are no longer needed.
extern "C" {
    static __heap_base: u8;
}
const COLORS_BYTES: usize = 64;
const SCAN_LEAD: usize = 64;
const PAD: usize = 64;

fn base() -> *mut u8 {
    ((core::ptr::addr_of!(__heap_base) as usize + 15) & !15) as *mut u8
}

/// The exact ink of each pixel (-1 for none) for the 5 rows around the row
/// being mapped. Each row has 16 bytes of -1 before it and at least 16 after,
/// and rows outside the image are all -1, so a 5x5 window needs no clamping.
struct Ring {
    start: *mut i8,
    stride: usize,
}

impl Ring {
    fn new(w: usize, h: usize) -> Self {
        let start = unsafe { base().add((COLORS_BYTES + SCAN_LEAD + 4 * w * h + PAD + 15) & !15) as *mut i8 };
        Ring { start, stride: w.next_multiple_of(16) + 32 }
    }
    fn len(&self) -> usize {
        5 * self.stride
    }
    /// Row y's exact inks; valid for the 5 rows last written.
    unsafe fn row(&self, y: usize) -> *mut i8 {
        self.start.add((y % 5) * self.stride + 16)
    }
}

/// Makes room for a w x h image; returns the buffer: colour words at +0, RGBA pixels at +128.
#[no_mangle]
pub extern "C" fn prepare(w: u32, h: u32) -> *mut u8 {
    let ring = Ring::new(w as usize, h as usize);
    let scanlines = (w as usize + 1) * h as usize;
    let packed = base() as usize + COLORS_BYTES + scanlines + png::bound(scanlines);
    let pages = (ring.start as usize + ring.len()).max(packed).div_ceil(65536);
    let have = memory_size(0);
    if pages > have && memory_grow(0, pages - have) == usize::MAX {
        unreachable() // out of memory
    }
    base()
}

/// Straight alpha onto white, rounded as Math.round((c * a + 255 * (255 - a)) / 255).
#[inline]
fn flatten(p: u32) -> u32 {
    let a = p >> 24;
    if a == 255 {
        return p;
    }
    let mut out = 0xff00_0000;
    for shift in [0, 8, 16] {
        let c = (p >> shift) & 0xff;
        out |= ((c * a + 255 * (255 - a) + 127) / 255) << shift;
    }
    out
}

#[cold]
#[inline(never)]
unsafe fn flatten16(p: *mut u32) {
    for i in 0..16 {
        *p.add(i) = flatten(*p.add(i));
    }
}

/// Loads 16 pixels, flattening them in place first if any is not opaque.
#[inline(always)]
unsafe fn load_opaque(p: *mut u32) -> [v128; 4] {
    let load = || [0, 1, 2, 3].map(|j| v128_load(p.add(4 * j) as *const v128));
    let v = load();
    // Alpha is the top byte: all 16 are 255 when it is 255 in the four ANDed together.
    let all = v128_and(v128_and(v[0], v[1]), v128_and(v[2], v[3]));
    if u32x4_all_true(u32x4_ge(all, u32x4_splat(0xff00_0000))) {
        return v;
    }
    flatten16(p);
    load()
}

// Next to a thin stroke, an edge pixel joins the stroke from about 30% coverage:
// see src/image.js.
const BACKGROUND_WEIGHT: i8 = 5;
const THICK: u8 = 6;

struct Inks<const K: usize> {
    keys: [u32; K],
    rgb: [[i32; 3]; K],
    base: [bool; K], // black and white
}

impl<const K: usize> Inks<K> {
    /// The squared distance from each of 4 pixels (their channels) to ink i.
    #[inline(always)]
    fn distance(&self, [r, g, b]: [v128; 3], i: usize) -> v128 {
        let [ir, ig, ib] = self.rgb[i];
        let (dr, dg, db) = (i32x4_sub(r, i32x4_splat(ir)), i32x4_sub(g, i32x4_splat(ig)), i32x4_sub(b, i32x4_splat(ib)));
        i32x4_add(i32x4_add(i32x4_mul(dr, dr), i32x4_mul(dg, dg)), i32x4_mul(db, db))
    }

    /// The nearest of all inks for 4 pixels; the lowest index wins a tie.
    #[inline(always)]
    fn nearest4(&self, p: v128) -> v128 {
        let p = channels(p);
        let mut best = i32x4_splat(i32::MAX);
        let mut index = i32x4_splat(0);
        for i in 0..K {
            let d = self.distance(p, i);
            index = v128_bitselect(i32x4_splat(i as i32), index, i32x4_lt(d, best));
            best = i32x4_min(d, best);
        }
        index
    }
}

#[inline(always)]
fn channels(p: v128) -> [v128; 3] {
    let byte = u32x4_splat(0xff);
    [v128_and(p, byte), v128_and(u32x4_shr(p, 8), byte), v128_and(u32x4_shr(p, 16), byte)]
}

/// Maps the pixels onto the inks (n_inks words at +0); returns the scanlines.
#[no_mangle]
pub extern "C" fn map_inks(w: u32, h: u32, n_inks: u32) -> *const u8 {
    // One copy of the loops per palette size, so they are unrolled over the inks.
    let (w, h) = (w as usize, h as usize);
    match n_inks {
        2 => map::<2>(w, h),
        3 => map::<3>(w, h),
        4 => map::<4>(w, h),
        6 => map::<6>(w, h),
        _ => unreachable(),
    }
}

#[inline(never)]
fn map<const K: usize>(w: usize, h: usize) -> *const u8 {
    let b = base();
    let mut inks = Inks { keys: [0; K], rgb: [[0; 3]; K], base: [false; K] };
    for i in 0..K {
        let key = unsafe { *(b as *const u32).add(i) };
        inks.keys[i] = key;
        inks.rgb[i] = [(key & 0xff) as i32, ((key >> 8) & 0xff) as i32, ((key >> 16) & 0xff) as i32];
        inks.base[i] = key == 0xff00_0000 || key == 0xffff_ffff;
    }
    let ring = Ring::new(w, h);
    unsafe {
        let rows = b.add(COLORS_BYTES);
        let px = rows.add(SCAN_LEAD) as *mut u32;
        ring.start.write_bytes(0xff, ring.len());
        // Row y is mapped once row y + 2 is classified, as an edge pixel looks 2 px around it.
        for y in 0..h + 2 {
            if y < h {
                classify_row(&inks, px.add(y * w), ring.row(y), w);
            } else {
                ring.row(y).write_bytes(0xff, w);
            }
            if y >= 2 {
                let y = y - 2;
                let around = [ring.row(y + 3), ring.row(y + 4), ring.row(y), ring.row(y + 1), ring.row(y + 2)];
                let line = rows.add(y * (w + 1));
                *line = 0; // filter: none
                map_row(&inks, px.add(y * w), around, line.add(1), w);
            }
        }
        rows
    }
}

/// Flattens a row and marks each pixel's exact ink (-1 for none).
#[inline(always)]
unsafe fn classify_row<const K: usize>(inks: &Inks<K>, px: *mut u32, exact: *mut i8, w: usize) {
    let mut x = 0;
    while x < w {
        let v = load_opaque(px.add(x));
        // Flat UI: mostly 16 pixels of one colour.
        let first = u32x4_splat(*px.add(x));
        let same = v.map(|v| i32x4_eq(v, first));
        if u32x4_all_true(v128_and(v128_and(same[0], same[1]), v128_and(same[2], same[3]))) {
            let p = *px.add(x);
            let mut e = -1i8;
            for i in 0..K {
                if inks.keys[i] == p {
                    e = i as i8;
                }
            }
            v128_store(exact.add(x) as *mut v128, i8x16_splat(e));
            x += 16;
            continue;
        }
        let idx = v.map(|v| {
            let mut idx = i32x4_splat(-1);
            for i in 0..K {
                idx = v128_bitselect(i32x4_splat(i as i32), idx, i32x4_eq(v, u32x4_splat(inks.keys[i])));
            }
            idx
        });
        let (lo, hi) = (i16x8_narrow_i32x4(idx[0], idx[1]), i16x8_narrow_i32x4(idx[2], idx[3]));
        v128_store(exact.add(x) as *mut v128, i8x16_narrow_i16x8(lo, hi));
        x += 16;
    }
    v128_store(exact.add(w) as *mut v128, i8x16_splat(-1)); // the padding the loop ran into
}

/// Writes row y's indices: exact pixels keep their ink, others take the
/// nearest (see `edges`). `around` are the exact inks of rows y-2..=y+2.
#[inline(always)]
unsafe fn map_row<const K: usize>(inks: &Inks<K>, px: *const u32, around: [*mut i8; 5], out: *mut u8, w: usize) {
    let mut x = 0;
    while x < w {
        let v = v128_load(around[2].add(x) as *const v128);
        // The pixels that are no ink exactly.
        let mut m = i8x16_bitmask(v) as u32;
        if w - x < 16 {
            m &= (1 << (w - x)) - 1;
        }
        if m == 0 {
            v128_store(out.add(x) as *mut v128, v);
            x += 16;
            continue;
        }
        // Columns x-2..x+14 and x+14..x+30 of the 5 rows.
        let a = around.map(|r| v128_load(r.add(x).sub(2) as *const v128));
        let b = around.map(|r| v128_load(r.add(x + 14) as *const v128));
        let and5 = |v: [v128; 5]| v128_and(v128_and(v128_and(v[0], v[1]), v128_and(v[2], v[3])), v[4]);
        let mut index = [i32x4_splat(0); 4];
        if i8x16_bitmask(and5(a)) == 0xffff && i8x16_bitmask(and5(b)) & 0xf == 0xf {
            // No exact ink within 2 px of any of them: the nearest ink.
            for (q, index) in index.iter_mut().enumerate() {
                if (m >> (4 * q)) & 0xf != 0 {
                    *index = inks.nearest4(v128_load(px.add(x + 4 * q) as *const v128));
                }
            }
        } else {
            let weights = edge_weights(inks, a, b);
            for (q, index) in index.iter_mut().enumerate() {
                if (m >> (4 * q)) & 0xf != 0 {
                    let p = channels(v128_load(px.add(x + 4 * q) as *const v128));
                    let mut best = u32x4_splat(u32::MAX);
                    for i in 0..K {
                        // Weighted distance; an ink that is not a candidate (weight 0) is u32::MAX away.
                        let weight = quad(weights[i], q);
                        let d = i32x4_add(i32x4_mul(inks.distance(p, i), weight), i32x4_eq(weight, i32x4_splat(0)));
                        *index = v128_bitselect(i32x4_splat(i as i32), *index, u32x4_lt(d, best));
                        best = u32x4_min(d, best);
                    }
                }
            }
        }
        let index = i8x16_narrow_i16x8(i16x8_narrow_i32x4(index[0], index[1]), i16x8_narrow_i32x4(index[2], index[3]));
        v128_store(out.add(x) as *mut v128, v128_bitselect(index, v, i8x16_shr(v, 7)));
        x += 16;
    }
}

/// Bytes 4q..4q+4 as 32-bit lanes.
#[inline(always)]
fn quad(v: v128, q: usize) -> v128 {
    let half = if q < 2 { u16x8_extend_low_u8x16(v) } else { u16x8_extend_high_u8x16(v) };
    if q % 2 == 0 {
        u32x4_extend_low_u16x8(half)
    } else {
        u32x4_extend_high_u16x8(half)
    }
}

/// For 16 pixels, each ink's distance weight (0: not a candidate), from the
/// exact inks in each pixel's 5x5 window: `a` and `b` hold columns x-2..x+14
/// and x+14..x+30 of the 5 rows.
///
/// With no exact ink in the window every ink is a candidate. Otherwise (an
/// anti-aliased edge) the candidates are black, white and the inks in the
/// window; the most common of them is the background and counts as
/// BACKGROUND_WEIGHT times further away, unless the second most common has
/// THICK pixels or more.
#[inline(always)]
unsafe fn edge_weights<const K: usize>(inks: &Inks<K>, a: [v128; 5], b: [v128; 5]) -> [v128; K] {
    let zero = i8x16_splat(0);
    let mut counts = [zero; K];
    let (mut max, mut second, mut background) = (zero, zero, zero);
    for i in 0..K {
        // Ink i's pixels per column, then per 5-wide window.
        let ink = i8x16_splat(i as i8);
        let column = |v: [v128; 5]| {
            let eq = v.map(|v| i8x16_eq(v, ink));
            i8x16_neg(i8x16_add(i8x16_add(i8x16_add(eq[0], eq[1]), i8x16_add(eq[2], eq[3])), eq[4]))
        };
        let (ca, cb) = (column(a), column(b));
        let c = i8x16_add(
            i8x16_add(
                i8x16_add(ca, i8x16_shuffle::<1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16>(ca, cb)),
                i8x16_add(
                    i8x16_shuffle::<2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17>(ca, cb),
                    i8x16_shuffle::<3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18>(ca, cb),
                ),
            ),
            i8x16_shuffle::<4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19>(ca, cb),
        );
        counts[i] = c;
        // The most common ink (the lowest index on a tie) and the runner-up's count.
        let more = u8x16_gt(c, max);
        second = v128_bitselect(max, u8x16_max(second, c), more);
        background = v128_bitselect(ink, background, more);
        max = u8x16_max(max, c);
    }
    let none = i8x16_eq(max, zero);
    let weighted = v128_andnot(u8x16_lt(second, u8x16_splat(THICK)), none);
    let mut weights = [zero; K];
    for i in 0..K {
        let candidate = v128_or(v128_or(u8x16_gt(counts[i], zero), none), i8x16_splat(-(inks.base[i] as i8)));
        let is_background = v128_and(i8x16_eq(background, i8x16_splat(i as i8)), weighted);
        weights[i] = v128_and(candidate, v128_bitselect(i8x16_splat(BACKGROUND_WEIGHT), i8x16_splat(1), is_background));
    }
    weights
}

/// Maps the pixels onto `levels` evenly spaced greys by luminance; returns the scanlines.
#[no_mangle]
pub extern "C" fn map_gray(w: u32, h: u32, levels: u32) -> *const u8 {
    let (w, h, b) = (w as usize, h as usize, base());
    let scale = (levels - 1) as f64;
    // Same operations, in the same order, as the JS it replaces, so levels match.
    let level = |p: u32| {
        let luma = 0.299 * (p & 0xff) as f64 + 0.587 * ((p >> 8) & 0xff) as f64 + 0.114 * ((p >> 16) & 0xff) as f64;
        // Rounded as Math.round; the value is never negative.
        let v = (luma * scale) / 255.0;
        let t = v as u32;
        (t + (v - t as f64 >= 0.5) as u32) as u8
    };
    unsafe {
        let rows = b.add(COLORS_BYTES);
        let px = rows.add(SCAN_LEAD) as *mut u32;
        // Flat UI repeats colours in long runs: reuse the previous pixel's level.
        let mut last = 0; // no flattened pixel is 0: alpha is 255
        let mut lv = 0u8;
        for y in 0..h {
            let line = rows.add(y * (w + 1));
            *line = 0; // filter: none
            let out = line.add(1);
            let row = px.add(y * w);
            let mut x = 0;
            while x < w {
                let v = load_opaque(row.add(x));
                let same = v.map(|v| i32x4_eq(v, u32x4_splat(last)));
                if u32x4_all_true(v128_and(v128_and(same[0], same[1]), v128_and(same[2], same[3]))) {
                    v128_store(out.add(x) as *mut v128, u8x16_splat(lv));
                } else {
                    for j in x..x + 16 {
                        let p = *row.add(j);
                        if p != last {
                            last = p;
                            lv = level(p);
                        }
                        *out.add(j) = lv;
                    }
                }
                x += 16;
            }
        }
        rows
    }
}

/// Writes the PNG of the scanlines, in the `colors` words at +0, right after them; returns its length.
#[no_mangle]
pub extern "C" fn png(w: u32, h: u32, colors: u32) -> usize {
    let (w, h) = (w as usize, h as usize);
    unsafe {
        let rows = base().add(COLORS_BYTES);
        png::write(rows.add((w + 1) * h), w, h, base() as *const u32, colors as usize, rows)
    }
}

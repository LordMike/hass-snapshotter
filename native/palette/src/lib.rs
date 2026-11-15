// The palette mapping's pixel loops, built for WebAssembly with SIMD128
// (`sh native/palette/build.sh`). src/image.js keeps the rules' description, writes the
// inks and the pixels into the buffer from `prepare`, and calls `map_inks` or
// `map_gray`, which return PNG scanlines (filter byte 0, then one index per
// pixel) ready for deflate.
//
// Both make one pass down the image: each row is flattened onto white,
// classified and mapped while it is still in cache. `map_inks` maps row y once
// row y + 2 is classified, as an edge pixel looks 2 px around it.
use core::arch::wasm32::*;

// The buffer: up to 8 ink words, then the pixels, the scanlines, then per-pixel
// scratch (exact ink, exact pixels nearby). Kept between calls, grown as needed.
static mut BUF: Vec<u32> = Vec::new();
const INKS_BYTES: usize = 32;

struct Layout {
    w: usize,
    h: usize,
    n: usize,
}

impl Layout {
    fn new(w: u32, h: u32) -> Self {
        let (w, h) = (w as usize, h as usize);
        Layout { w, h, n: w * h }
    }
    fn pixels(&self) -> usize {
        INKS_BYTES
    }
    fn rows(&self) -> usize {
        self.pixels() + 4 * self.n
    }
    fn exact(&self) -> usize {
        self.rows() + (self.w + 1) * self.h
    }
    fn near(&self) -> usize {
        self.exact() + self.n
    }
    fn len(&self) -> usize {
        self.near() + self.n
    }
}

fn base() -> *mut u8 {
    unsafe { (*core::ptr::addr_of_mut!(BUF)).as_mut_ptr() as *mut u8 }
}

/// Makes room for a w x h image; returns the buffer: ink words at +0, RGBA pixels at +32.
#[no_mangle]
pub extern "C" fn prepare(w: u32, h: u32) -> *mut u8 {
    let words = Layout::new(w, h).len().div_ceil(4);
    let buf = unsafe { &mut *core::ptr::addr_of_mut!(BUF) };
    if buf.len() < words {
        buf.resize(words, 0);
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

const OPAQUE: u32 = 0xff00_0000;

/// Flattens 4 pixels if any is not opaque; returns them.
#[inline]
unsafe fn load_opaque(p: *mut u32) -> v128 {
    let v = v128_load(p as *const v128);
    if u32x4_all_true(i32x4_eq(v128_and(v, u32x4_splat(OPAQUE)), u32x4_splat(OPAQUE))) {
        return v;
    }
    for i in 0..4 {
        *p.add(i) = flatten(*p.add(i));
    }
    v128_load(p as *const v128)
}

// Next to a thin stroke, an edge pixel joins the stroke from about 30% coverage:
// see src/image.js.
const BACKGROUND_WEIGHT: i32 = 5;
const THICK: u8 = 6;

struct Inks {
    keys: [u32; 8],
    rgb: [[i32; 3]; 8],
    k: usize,
    base_mask: u32,
}

impl Inks {
    #[inline]
    fn nearest(&self, p: u32, mask: u32, background: usize) -> u8 {
        let (r, g, b) = ((p & 0xff) as i32, ((p >> 8) & 0xff) as i32, ((p >> 16) & 0xff) as i32);
        let mut best = 0;
        let mut best_dist = i32::MAX;
        for i in 0..self.k {
            if mask & (1 << i) == 0 {
                continue;
            }
            let [ir, ig, ib] = self.rgb[i];
            let (dr, dg, db) = (r - ir, g - ig, b - ib);
            let mut d = dr * dr + dg * dg + db * db;
            if i == background {
                d *= BACKGROUND_WEIGHT;
            }
            if d < best_dist {
                best = i;
                best_dist = d;
            }
        }
        best as u8
    }

    /// `nearest` over all inks for 4 pixels at once.
    #[inline]
    fn nearest4(&self, p: v128) -> v128 {
        let byte = u32x4_splat(0xff);
        let (r, g, b) = (v128_and(p, byte), v128_and(u32x4_shr(p, 8), byte), v128_and(u32x4_shr(p, 16), byte));
        let mut best = i32x4_splat(i32::MAX);
        let mut index = i32x4_splat(0);
        for i in 0..self.k {
            let [ir, ig, ib] = self.rgb[i];
            let (dr, dg, db) = (i32x4_sub(r, i32x4_splat(ir)), i32x4_sub(g, i32x4_splat(ig)), i32x4_sub(b, i32x4_splat(ib)));
            let d = i32x4_add(i32x4_add(i32x4_mul(dr, dr), i32x4_mul(dg, dg)), i32x4_mul(db, db));
            index = v128_bitselect(i32x4_splat(i as i32), index, i32x4_lt(d, best));
            best = i32x4_min(d, best);
        }
        index
    }
}

/// Maps the pixels onto the inks (n_inks words at +0); returns the scanlines.
#[no_mangle]
pub extern "C" fn map_inks(w: u32, h: u32, n_inks: u32) -> *const u8 {
    let l = Layout::new(w, h);
    let (w, h, b) = (l.w, l.h, base());
    let mut inks = Inks { keys: [0; 8], rgb: [[0; 3]; 8], k: n_inks as usize, base_mask: 0 };
    for i in 0..inks.k {
        let key = unsafe { *(b as *const u32).add(i) };
        inks.keys[i] = key;
        inks.rgb[i] = [(key & 0xff) as i32, ((key >> 8) & 0xff) as i32, ((key >> 16) & 0xff) as i32];
        if key == 0xff00_0000 || key == 0xffff_ffff {
            inks.base_mask |= 1 << i; // black and white
        }
    }
    unsafe {
        let px = b.add(l.pixels()) as *mut u32;
        let rows = b.add(l.rows());
        let exact = b.add(l.exact()) as *mut i8;
        let near = b.add(l.near());
        for y in 0..h + 2 {
            if y < h {
                classify_row(&inks, px.add(y * w), exact.add(y * w), near.add(y * w), w);
            }
            if y >= 2 {
                let y = y - 2;
                map_row(&inks, px, exact, near, rows.add(y * (w + 1)), w, h, y);
            }
        }
        rows
    }
}

/// Flattens a row, marks each pixel's exact ink (-1 for none), and counts the
/// exact pixels in each pixel's 5-wide span.
unsafe fn classify_row(inks: &Inks, px: *mut u32, exact: *mut i8, near: *mut u8, w: usize) {
    let mut x = 0;
    while x + 16 <= w {
        let mut idx = [i32x4_splat(-1); 4];
        for (j, idx) in idx.iter_mut().enumerate() {
            let v = load_opaque(px.add(x + 4 * j));
            for i in 0..inks.k {
                *idx = v128_bitselect(i32x4_splat(i as i32), *idx, i32x4_eq(v, u32x4_splat(inks.keys[i])));
            }
        }
        let lo = i16x8_narrow_i32x4(idx[0], idx[1]);
        let hi = i16x8_narrow_i32x4(idx[2], idx[3]);
        v128_store(exact.add(x) as *mut v128, i8x16_narrow_i16x8(lo, hi));
        x += 16;
    }
    for x in x..w {
        let p = flatten(*px.add(x));
        *px.add(x) = p;
        *exact.add(x) = inks.keys[..inks.k].iter().position(|&k| k == p).map_or(-1, |i| i as i8);
    }

    // 1 for an exact pixel, summed over x-2..=x+2.
    let is = |x: usize| (*exact.add(x) >= 0) as u8;
    let one = |v: v128| i8x16_add(i8x16_splat(1), i8x16_shr(v, 7));
    let mut x = 0;
    while x < w.min(2) {
        *near.add(x) = (x.saturating_sub(2)..(x + 3).min(w)).map(|i| is(i)).sum();
        x += 1;
    }
    while x + 2 + 16 <= w {
        let e = |d: usize| one(v128_load(exact.add(x + d - 2) as *const v128));
        let sum = i8x16_add(i8x16_add(i8x16_add(e(0), e(1)), i8x16_add(e(2), e(3))), e(4));
        v128_store(near.add(x) as *mut v128, sum);
        x += 16;
    }
    for x in x..w {
        *near.add(x) = (x - 2..(x + 3).min(w)).map(|i| is(i)).sum();
    }
}

/// Writes row y's scanline: exact pixels keep their ink, others take the nearest.
#[allow(clippy::too_many_arguments)]
unsafe fn map_row(inks: &Inks, px: *const u32, exact: *const i8, near: *const u8, line: *mut u8, w: usize, h: usize, y: usize) {
    *line = 0; // filter: none
    let out = line.add(1);
    let row = exact.add(y * w);
    let mut x = 0;
    while x + 16 <= w {
        let v = v128_load(row.add(x) as *const v128);
        v128_store(out.add(x) as *mut v128, v);
        let mut m = i8x16_bitmask(v);
        if m != 0 {
            // Pixels with no exact ink in their 5x5 window take the nearest ink, 4 at a time.
            let mut any = u8x16_splat(0);
            for yy in y.saturating_sub(2)..=(y + 2).min(h - 1) {
                any = u8x16_add(any, v128_load(near.add(yy * w + x) as *const v128));
            }
            let far = i8x16_bitmask(u8x16_eq(any, u8x16_splat(0))) & m;
            for q in 0..4 {
                if (far >> (4 * q)) & 0xf == 0xf {
                    let i = inks.nearest4(v128_load(px.add(y * w + x + 4 * q) as *const v128));
                    let i = i16x8_narrow_i32x4(i, i);
                    let i = i8x16_narrow_i16x8(i, i);
                    (out.add(x + 4 * q) as *mut u32).write_unaligned(u32x4_extract_lane::<0>(i));
                    m &= !(0xf << (4 * q));
                }
            }
        }
        while m != 0 {
            let j = m.trailing_zeros() as usize;
            *out.add(x + j) = inexact(inks, px, exact, near, w, h, x + j, y);
            m &= m - 1;
        }
        x += 16;
    }
    for x in x..w {
        let e = *row.add(x);
        *out.add(x) = if e >= 0 { e as u8 } else { inexact(inks, px, exact, near, w, h, x, y) };
    }
}

/// A pixel that is no ink exactly. Next to exact inks (an anti-aliased edge) it
/// takes the nearest of black, white and those inks, the most common of them
/// weighted as the background unless the other side is thick too; elsewhere,
/// the nearest ink.
#[allow(clippy::too_many_arguments)]
#[inline]
unsafe fn inexact(inks: &Inks, px: *const u32, exact: *const i8, near: *const u8, w: usize, h: usize, x: usize, y: usize) -> u8 {
    let p = *px.add(y * w + x);
    let (y0, y1) = (y.saturating_sub(2), (y + 2).min(h - 1));
    let mut any = 0u32;
    for yy in y0..=y1 {
        any += *near.add(yy * w + x) as u32;
    }
    if any == 0 {
        return inks.nearest(p, (1 << inks.k) - 1, usize::MAX);
    }
    let mut mask = inks.base_mask;
    let mut counts = [0u8; 8];
    let (x0, x1) = (x.saturating_sub(2), (x + 2).min(w - 1));
    for yy in y0..=y1 {
        for xx in x0..=x1 {
            let e = *exact.add(yy * w + xx);
            if e >= 0 {
                mask |= 1 << e;
                counts[e as usize] += 1;
            }
        }
    }
    let (mut background, mut max, mut second) = (usize::MAX, 0, 0);
    for (i, &c) in counts[..inks.k].iter().enumerate() {
        if c > max {
            second = max;
            max = c;
            background = i;
        } else if c > second {
            second = c;
        }
    }
    if second >= THICK {
        background = usize::MAX; // edge of a thick shape: plain 50% cut
    }
    inks.nearest(p, mask, background)
}

/// Maps the pixels onto `levels` evenly spaced greys by luminance; returns the scanlines.
#[no_mangle]
pub extern "C" fn map_gray(w: u32, h: u32, levels: u32) -> *const u8 {
    let l = Layout::new(w, h);
    let (w, h, b) = (l.w, l.h, base());
    let scale = (levels - 1) as f64;
    // Same operations, in the same order, as the JS it replaces, so levels match.
    let level = |p: u32| {
        let luma = 0.299 * (p & 0xff) as f64 + 0.587 * ((p >> 8) & 0xff) as f64 + 0.114 * ((p >> 16) & 0xff) as f64;
        ((luma * scale) / 255.0).round() as u8
    };
    unsafe {
        let px = b.add(l.pixels()) as *mut u32;
        let rows = b.add(l.rows());
        // Flat UI repeats colours in long runs: reuse the previous pixel's level.
        let mut last = 0; // no flattened pixel is 0: alpha is 255
        let mut lv = 0u8;
        for y in 0..h {
            let line = rows.add(y * (w + 1));
            *line = 0;
            let out = line.add(1);
            let row = px.add(y * w);
            let mut x = 0;
            while x + 4 <= w {
                let v = load_opaque(row.add(x));
                if u32x4_all_true(i32x4_eq(v, u32x4_splat(last))) {
                    (out.add(x) as *mut u32).write_unaligned(u32::from_ne_bytes([lv; 4]));
                } else {
                    for j in 0..4 {
                        let p = *row.add(x + j);
                        if p != last {
                            last = p;
                            lv = level(p);
                        }
                        *out.add(x + j) = lv;
                    }
                }
                x += 4;
            }
            for x in x..w {
                let p = flatten(*row.add(x));
                if p != last {
                    last = p;
                    lv = level(p);
                }
                *out.add(x) = lv;
            }
        }
        rows
    }
}

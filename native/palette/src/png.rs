// A minimal 8-bit indexed PNG: IHDR, PLTE with the colours, one IDAT, IEND.
use crate::deflate;

/// The most room the file can take: the chunks around the stream, then `deflate::bound`.
pub fn bound(scanlines: usize) -> usize {
    256 + deflate::bound(scanlines)
}

const CRC: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut bit = 0;
        while bit < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            bit += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

unsafe fn put_u32(at: *mut u8, value: u32) {
    (at as *mut u32).write_unaligned(value.to_be());
}

/// Finishes the chunk at `at` whose `len` bytes of data are already in place
/// (at +8): length, type, CRC of type and data. Returns where the next one starts.
unsafe fn chunk(at: *mut u8, kind: &[u8; 4], len: usize) -> *mut u8 {
    put_u32(at, len as u32);
    at.add(4).copy_from(kind.as_ptr(), 4);
    let mut crc = !0u32;
    for i in 4..8 + len {
        crc = CRC[((crc ^ *at.add(i) as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    put_u32(at.add(8 + len), !crc);
    at.add(12 + len)
}

/// Writes the PNG of w x h `scanlines` (filter byte 0, then one index per
/// pixel) in `n` colours (RGBA words) at `out`; returns its length.
pub unsafe fn write(out: *mut u8, w: usize, h: usize, colors: *const u32, n: usize, scanlines: *const u8) -> usize {
    out.copy_from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].as_ptr(), 8);
    let mut at = out.add(8);
    put_u32(at.add(8), w as u32);
    put_u32(at.add(12), h as u32);
    at.add(16).copy_from([8, 3, 0, 0, 0].as_ptr(), 5); // bit depth 8, colour type 3 (palette)
    at = chunk(at, b"IHDR", 13);
    for i in 0..n {
        at.add(8 + 3 * i).copy_from(colors.add(i) as *const u8, 3);
    }
    at = chunk(at, b"PLTE", 3 * n);
    let len = deflate::zlib(scanlines, (w + 1) * h, at.add(8));
    at = chunk(at, b"IDAT", len);
    at = chunk(at, b"IEND", 0);
    at.offset_from(out) as usize
}

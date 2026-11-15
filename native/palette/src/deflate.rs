// A zlib stream for PNG scanlines of flat UI: runs of one byte become matches
// at distance 1 (as zlib's Z_RLE strategy does), coded with Huffman codes made
// for each block. Any inflate reads it.
use core::arch::wasm32::*;

const SYMBOLS: usize = 286; // literals 0..=255, end of block, match lengths
const END: usize = 256;
const BLOCK: usize = 65536; // bytes of input per block, each with its own codes
const CODE_LENGTH_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/// The most room the stream for `len` bytes can take: 15 bits a byte, the
/// block headers and the wrapper, then a block's tokens (4 bytes a byte).
pub fn bound(len: usize) -> usize {
    stream_bound(len) + 4 * len.min(BLOCK)
}

fn stream_bound(len: usize) -> usize {
    (2 * len + 2048 + 3) & !3
}

struct Bits {
    out: *mut u8,
    pending: u64,
    count: u32,
}

impl Bits {
    /// Appends the low `bits` (at most 32) of `value`, low bit first.
    #[inline(always)]
    unsafe fn put(&mut self, value: u32, bits: u32) {
        self.pending |= (value as u64) << self.count;
        self.count += bits;
        (self.out as *mut u64).write_unaligned(self.pending);
        let bytes = self.count / 8;
        self.out = self.out.add(bytes as usize);
        self.pending >>= bytes * 8;
        self.count %= 8;
    }
}

/// Calls `f(byte, 0)` for a literal and `f(byte, n)` for n (3..=258) more of the byte before.
#[inline(always)]
unsafe fn tokens(mut p: *const u8, end: *const u8, mut f: impl FnMut(u8, usize)) {
    while p < end {
        let b = *p;
        f(b, 0);
        p = p.add(1);
        // How many more of b follow.
        let room = end.offset_from(p) as usize;
        let mut more = 0;
        while more < room {
            let differ = !i8x16_bitmask(i8x16_eq(v128_load(p.add(more) as *const v128), u8x16_splat(b)));
            if differ != 0 {
                more += differ.trailing_zeros() as usize;
                break;
            }
            more += 16;
        }
        let mut more = more.min(room);
        p = p.add(more);
        while more >= 3 {
            let n = more.min(258);
            f(b, n);
            more -= n;
        }
        for _ in 0..more {
            f(b, 0);
        }
    }
}

/// The symbol for a match of `len` (3..=258), and its extra bits: how many, and their value.
#[inline(always)]
fn length_symbol(len: usize) -> (usize, u32, u32) {
    let l = len as u32 - 3;
    if len == 258 {
        (285, 0, 0)
    } else if l < 8 {
        (257 + l as usize, 0, 0)
    } else {
        let extra = 29 - l.leading_zeros();
        ((261 + 4 * extra + ((l >> extra) & 3)) as usize, extra, l & ((1 << extra) - 1))
    }
}

/// Huffman code lengths of at most `limit` bits for the symbols that occur.
fn code_lengths(counts: &[u32], limit: u8, lengths: &mut [u8]) {
    // The symbols that occur are the tree's leaves, nodes 0..used.
    let mut symbol = [0u16; SYMBOLS];
    let mut used = 0;
    for (i, &count) in counts.iter().enumerate() {
        lengths[i] = 0;
        if count > 0 {
            symbol[used] = i as u16;
            used += 1;
        }
    }
    if used == 1 {
        lengths[symbol[0] as usize] = 1; // a lone symbol still takes a bit
        return;
    }
    let mut weight = [0u32; 2 * SYMBOLS];
    let mut parent = [0u16; 2 * SYMBOLS];
    // Too deep a tree is rebuilt with the counts halved, which flattens it.
    for halvings in 0.. {
        for i in 0..used {
            weight[i] = ((counts[symbol[i] as usize] - 1) >> halvings) + 1;
            parent[i] = 0;
        }
        // Join the two lightest trees until one is left.
        for node in used..2 * used - 1 {
            let (mut a, mut b) = (usize::MAX, usize::MAX);
            for i in 0..node {
                if parent[i] == 0 {
                    if a == usize::MAX || weight[i] < weight[a] {
                        b = a;
                        a = i;
                    } else if b == usize::MAX || weight[i] < weight[b] {
                        b = i;
                    }
                }
            }
            weight[node] = weight[a] + weight[b];
            parent[node] = 0;
            parent[a] = node as u16;
            parent[b] = node as u16;
        }
        let mut deepest = 0;
        for i in 0..used {
            let (mut depth, mut node) = (0, i);
            while parent[node] != 0 {
                node = parent[node] as usize;
                depth += 1;
            }
            lengths[symbol[i] as usize] = depth;
            deepest = deepest.max(depth);
        }
        if deepest <= limit {
            return;
        }
    }
}

/// The canonical codes for the lengths, bit-reversed: deflate writes codes from their top bit.
fn codes(lengths: &[u8], codes: &mut [u16]) {
    let mut count = [0u16; 16];
    for &l in lengths {
        count[l as usize] += 1;
    }
    count[0] = 0;
    let mut next = [0u16; 16];
    for l in 1..16 {
        next[l] = (next[l - 1] + count[l - 1]) << 1;
    }
    for (i, &l) in lengths.iter().enumerate() {
        if l > 0 {
            codes[i] = next[l as usize].reverse_bits() >> (16 - l);
            next[l as usize] += 1;
        }
    }
}

/// The code lengths as deflate stores them: `f(symbol, extra bits, their value)`,
/// where 17 and 18 stand for 3..=10 and 11..=138 zeros.
fn stored_lengths(lengths: &[u8], mut f: impl FnMut(usize, u32, u32)) {
    let mut i = 0;
    while i < lengths.len() {
        let zeros = lengths[i..].iter().take(138).take_while(|&&l| l == 0).count();
        if zeros >= 11 {
            f(18, 7, zeros as u32 - 11);
        } else if zeros >= 3 {
            f(17, 3, zeros as u32 - 3);
        } else {
            f(lengths[i] as usize, 0, 0);
        }
        i += if zeros >= 3 { zeros } else { 1 };
    }
}

/// Writes `len` bytes at `data` as a zlib stream at `out`; returns its length.
pub unsafe fn zlib(data: *const u8, len: usize, out: *mut u8) -> usize {
    let mut bits = Bits { out, pending: 0, count: 0 };
    bits.put(0x0178, 16); // deflate, 32K window; no dictionary
    let (mut s1, mut s2) = (1u32, 0u32); // Adler-32 of the data
    // A block's tokens: symbol, then at bit 9 how many bits follow its code and at bit 12 their value.
    let block = out.add(stream_bound(len)) as *mut u32;
    let mut start = 0;
    loop {
        let end = (start + BLOCK).min(len);
        let (from, to) = (data.add(start), data.add(end));

        let mut counts = [0u32; SYMBOLS];
        counts[END] = 1;
        let mut n_tokens = 0;
        tokens(from, to, |b, more| {
            let (b, n) = (b as u32, more as u32);
            let token = if more == 0 {
                s1 += b;
                s2 += s1;
                b
            } else {
                // n more of b: s1 grows by b each time, and s2 by s1.
                s2 += n * s1 + b * (n * (n + 1) / 2);
                s1 += n * b;
                // The length's extra bits, then the distance code: one 0 bit.
                let (symbol, extra, value) = length_symbol(more);
                symbol as u32 | (extra + 1) << 9 | value << 12
            };
            s1 %= 65521;
            s2 %= 65521;
            counts[(token & 511) as usize] += 1;
            *block.add(n_tokens) = token;
            n_tokens += 1;
        });
        // Lengths for the literal/length codes, then for two distance codes of a
        // bit each: 0 is distance 1, the other is unused but completes the code.
        let mut lengths = [0u8; SYMBOLS + 2];
        code_lengths(&counts, 15, &mut lengths[..SYMBOLS]);
        lengths[SYMBOLS..].fill(1);
        let mut code = [0u16; SYMBOLS];
        codes(&lengths[..SYMBOLS], &mut code);

        // Block header: last block?, dynamic codes, the alphabet sizes, then the
        // code lengths, themselves Huffman coded.
        let mut length_counts = [0u32; 19];
        stored_lengths(&lengths, |symbol, _, _| length_counts[symbol] += 1);
        let mut length_lengths = [0u8; 19];
        code_lengths(&length_counts, 7, &mut length_lengths);
        let mut length_code = [0u16; 19];
        codes(&length_lengths, &mut length_code);
        bits.put((end == len) as u32, 1);
        bits.put(2, 2);
        bits.put(SYMBOLS as u32 - 257, 5);
        bits.put(2 - 1, 5);
        bits.put(19 - 4, 4);
        for i in CODE_LENGTH_ORDER {
            bits.put(length_lengths[i] as u32, 3);
        }
        stored_lengths(&lengths, |symbol, extra, value| {
            bits.put(length_code[symbol] as u32, length_lengths[symbol] as u32);
            bits.put(value, extra);
        });

        for i in 0..n_tokens {
            let token = *block.add(i);
            let symbol = (token & 511) as usize;
            let l = lengths[symbol] as u32;
            bits.put(code[symbol] as u32 | (token >> 12) << l, l + ((token >> 9) & 7));
        }
        bits.put(code[END] as u32, lengths[END] as u32);
        if end == len {
            break;
        }
        start = end;
    }
    bits.put(0, 7); // to a whole byte
    (bits.out as *mut u32).write_unaligned((s2 << 16 | s1).to_be());
    bits.out.add(4).offset_from(out) as usize
}

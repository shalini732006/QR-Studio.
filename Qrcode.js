/*!
 * Tiny QR Code encoder — byte mode (UTF-8), versions 1–40, error correction L/M/Q/H.
 * No dependencies. Follows ISO/IEC 18004.
 *
 * Usage:
 *   const qr = QR.encode('https://example.com', 'M');
 *   qr.size            -> modules per side
 *   qr.modules[y][x]   -> true when the module is dark
 */
const QR = (function () {
  'use strict';

  const ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  const FORMAT_BITS = [1, 0, 3, 2]; // L, M, Q, H

  // Index: [eccLevel][version]; version 0 is a placeholder.
  const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  const bit = (x, i) => ((x >>> i) & 1) !== 0;

  function numRawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function numDataCodewords(ver, e) {
    return Math.floor(numRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
  }

  const charCountBits = (ver) => (ver <= 9 ? 8 : 16);

  /** Maximum number of UTF-8 bytes that fit in a given version. */
  function maxBytesForVersion(ver, eccLevel) {
    const e = ECC_INDEX[eccLevel];
    return Math.floor((numDataCodewords(ver, e) * 8 - 4 - charCountBits(ver)) / 8);
  }

  /** Maximum number of UTF-8 bytes at the largest version (40). */
  function maxBytes(eccLevel) {
    return maxBytesForVersion(40, eccLevel);
  }

  // ---------- Reed–Solomon over GF(256) ----------
  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
    }
    return result;
  }

  function addEccAndInterleave(data, ver, e) {
    const numBlocks = NUM_BLOCKS[e][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const divisor = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
      });
    }
    return result;
  }

  // ---------- Mask penalty (ISO/IEC 18004 §7.8.3) ----------
  const FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

  function matchesAt(line, i, pattern) {
    for (let k = 0; k < pattern.length; k++) if (line[i + k] !== pattern[k]) return false;
    return true;
  }

  function penaltyScore(modules, size) {
    let result = 0;

    // Rule 1 (runs of 5+) and Rule 3 (finder-like patterns), rows then columns
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        const line = new Array(size);
        let runColor = null;
        let runLen = 0;
        for (let b = 0; b < size; b++) {
          const c = pass === 0 ? modules[a][b] : modules[b][a];
          line[b] = c ? 1 : 0;
          if (c === runColor) {
            runLen++;
            if (runLen === 5) result += 3;
            else if (runLen > 5) result++;
          } else {
            runColor = c;
            runLen = 1;
          }
        }
        for (let i = 0; i + 11 <= size; i++) {
          if (matchesAt(line, i, FINDER_A) || matchesAt(line, i, FINDER_B)) result += 40;
        }
      }
    }

    // Rule 2: 2×2 blocks of one colour
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }

    // Rule 4: dark/light balance
    let dark = 0;
    for (const row of modules) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;

    return result;
  }

  // ---------- Encoder ----------
  function encode(text, eccLevel) {
    eccLevel = eccLevel || 'M';
    const e = ECC_INDEX[eccLevel];
    if (e === undefined) throw new RangeError('Unknown error-correction level: ' + eccLevel);

    const bytes = Array.from(new TextEncoder().encode(String(text)));

    // Smallest version that fits
    let ver = 1;
    for (; ; ver++) {
      const cap = numDataCodewords(ver, e) * 8;
      const ccBits = charCountBits(ver);
      if (bytes.length < (1 << ccBits) && 4 + ccBits + bytes.length * 8 <= cap) break;
      if (ver >= 40) throw new RangeError('Data too long');
    }

    // Bit stream: mode (byte), char count, data, terminator, padding
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    const capBits = numDataCodewords(ver, e) * 8;
    push(0x4, 4);
    push(bytes.length, charCountBits(ver));
    bytes.forEach((b) => push(b, 8));
    push(0, Math.min(4, capBits - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) push(pad, 8);

    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      dataCodewords.push(v);
    }

    const allCodewords = addEccAndInterleave(dataCodewords, ver, e);

    // Matrix
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    function drawFinder(cx, cy) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    }

    function drawAlignment(cx, cy) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    function alignmentPositions() {
      if (ver === 1) return [];
      const n = Math.floor(ver / 7) + 2;
      const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      const res = [6];
      for (let pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
      return res;
    }

    function drawFormatBits(mask) {
      const data = (FORMAT_BITS[e] << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits15 = ((data << 10) | rem) ^ 0x5412;

      for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits15, i));
      setFn(8, 7, bit(bits15, 6));
      setFn(8, 8, bit(bits15, 7));
      setFn(7, 8, bit(bits15, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits15, i));

      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits15, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits15, i));
      setFn(8, size - 8, true); // always-dark module
    }

    function drawVersion() {
      if (ver < 7) return;
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits18 = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const color = bit(bits18, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFn(a, b, color);
        setFn(b, a, color);
      }
    }

    // Function patterns
    for (let i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);
    const align = alignmentPositions();
    const n = align.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) {
          drawAlignment(align[i], align[j]);
        }
      }
    }
    drawFormatBits(0); // placeholder, reserves the area
    drawVersion();

    // Zig-zag codeword placement
    let idx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && idx < allCodewords.length * 8) {
            modules[y][x] = bit(allCodewords[idx >>> 3], 7 - (idx & 7));
            idx++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let invert;
          switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
            case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          }
          if (!isFn[y][x] && invert) modules[y][x] = !modules[y][x];
        }
      }
    }

    // Choose the mask with the lowest penalty
    let bestMask = 0;
    let minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormatBits(m);
      const p = penaltyScore(modules, size);
      if (p < minPenalty) { minPenalty = p; bestMask = m; }
      applyMask(m); // undo
    }
    applyMask(bestMask);
    drawFormatBits(bestMask);

    return { version: ver, size, mask: bestMask, ecc: eccLevel, dataBytes: bytes.length, modules };
  }

  const api = { encode, maxBytes, maxBytesForVersion };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
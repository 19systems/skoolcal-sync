/*
 * scripts/make-icons.mjs — generates the extension PNG icons with no external
 * dependencies (a tiny rasteriser + PNG encoder).
 *
 * Run: npm run icons
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "icons");
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor for smooth edges

/* ---- PNG encoding ------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---- drawing ----------------------------------------------------------- */

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function roundedRectContains(x, y, rx, ry, rw, rh, radius) {
  if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + radius), rx + rw - radius);
  const cy = Math.min(Math.max(y, ry + radius), ry + rh - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius + 0.0001;
}

/** Distance from point to a line segment, for stroke rendering. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const lx = x1 + t * dx;
  const ly = y1 + t * dy;
  return Math.hypot(px - lx, py - ly);
}

function renderIcon(size) {
  const S = size * SS;
  const buf = Buffer.alloc(S * S * 4);

  const put = (x, y, color, alpha) => {
    if (alpha <= 0) return;
    const i = (y * S + x) * 4;
    const a = Math.min(1, alpha);
    const dstA = buf[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c++) {
      buf[i + c] = Math.round((color[c] * a + buf[i + c] * dstA * (1 - a)) / outA);
    }
    buf[i + 3] = Math.round(outA * 255);
  };

  const top = [99, 102, 241];    // indigo-500
  const bottom = [67, 56, 202];  // indigo-700
  const white = [255, 255, 255];
  const accent = [79, 70, 229];

  const radius = S * 0.22;

  for (let y = 0; y < S; y++) {
    const t = y / (S - 1);
    const bg = mix(top, bottom, t);
    for (let x = 0; x < S; x++) {
      if (!roundedRectContains(x + 0.5, y + 0.5, 0, 0, S, S, radius)) continue;
      put(x, y, bg, 1);

      // Calendar body.
      const bx = S * 0.17, by = S * 0.24, bw = S * 0.66, bh = S * 0.58;
      if (roundedRectContains(x + 0.5, y + 0.5, bx, by, bw, bh, S * 0.07)) {
        put(x, y, white, 1);

        // Header band.
        if (y + 0.5 < by + bh * 0.26) {
          // Re-clip the header to the rounded top.
          if (roundedRectContains(x + 0.5, y + 0.5, bx, by, bw, bh, S * 0.07)) {
            put(x, y, mix(accent, bottom, 0.25), 1);
          }
        }
      }
    }
  }

  // Binding rings.
  const ringTop = S * 0.15;
  const ringBottom = S * 0.30;
  const ringRadius = S * 0.045;
  [0.34, 0.66].forEach((fx) => {
    for (let y = Math.floor(ringTop); y < Math.ceil(ringBottom); y++) {
      for (let x = Math.floor(S * fx - ringRadius - 2); x < Math.ceil(S * fx + ringRadius + 2); x++) {
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        const d = Math.hypot(x + 0.5 - S * fx, y + 0.5 - (ringTop + ringBottom) / 2);
        const w = S * 0.032;
        if (Math.abs(d - ringRadius) <= w / 2) put(x, y, white, 1);
      }
    }
  });

  // Check mark.
  const p1 = [S * 0.34, S * 0.58];
  const p2 = [S * 0.46, S * 0.69];
  const p3 = [S * 0.68, S * 0.45];
  const thickness = S * 0.075;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = Math.min(
        distToSegment(px, py, p1[0], p1[1], p2[0], p2[1]),
        distToSegment(px, py, p2[0], p2[1], p3[0], p3[1])
      );
      if (d <= thickness / 2) {
        const edge = Math.min(1, (thickness / 2 - d) / (SS * 0.6));
        put(x, y, accent, edge);
      }
    }
  }

  // Downsample.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          const pa = buf[i + 3] / 255;
          r += buf[i] * pa;
          gg += buf[i + 1] * pa;
          b += buf[i + 2] * pa;
          a += pa;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(gg / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }

  return encodePng(size, size, out);
}

/* ---- main -------------------------------------------------------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = renderIcon(size);
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(ROOT, file)} (${png.length} bytes)`);
}

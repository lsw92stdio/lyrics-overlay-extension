/**
 * Icon generator — pure Node.js, no dependencies
 * Outputs icon16.png, icon48.png, icon128.png
 *
 * Design: amber ♪ music note on #111 dark rounded-square background
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── PNG writer ──────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf, offset = 0, len = buf.length - offset) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ buf[offset + i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type);
  const d = Buffer.from(data);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const combined = Buffer.concat([t, d]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(combined));
  return Buffer.concat([len, t, d, crcBuf]);
}

function encodePNG(w, h, rgba) {
  // raw scanlines: filter-byte(0) + RGBA row
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    row[0] = 0; // None filter
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row[1 + x * 4]     = rgba[i];
      row[1 + x * 4 + 1] = rgba[i + 1];
      row[1 + x * 4 + 2] = rgba[i + 2];
      row[1 + x * 4 + 3] = rgba[i + 3];
    }
    rows.push(row);
  }
  const raw = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', raw),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Rasteriser helpers ───────────────────────────────────────────────────────
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.buf = new Uint8Array(w * h * 4); // RGBA, starts transparent
  }
  set(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    // Alpha-composite over existing
    const srcA = a / 255, dstA = this.buf[i+3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA < 1e-6) return;
    this.buf[i]   = Math.round((r * srcA + this.buf[i]   * dstA * (1 - srcA)) / outA);
    this.buf[i+1] = Math.round((g * srcA + this.buf[i+1] * dstA * (1 - srcA)) / outA);
    this.buf[i+2] = Math.round((b * srcA + this.buf[i+2] * dstA * (1 - srcA)) / outA);
    this.buf[i+3] = Math.round(outA * 255);
  }

  // Anti-aliased circle fill (xiaolin-wu-style coverage per pixel)
  fillEllipse(cx, cy, rx, ry, ang, r, g, b) {
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const x0 = Math.floor(cx - rx - 1), x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1), y1 = Math.ceil(cy + ry + 1);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // AA: sample 2×2 sub-pixels
        let cov = 0;
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
          const fx = px + sx * 0.5 + 0.25 - cx;
          const fy = py + sy * 0.5 + 0.25 - cy;
          const lx =  fx * cos + fy * sin;
          const ly = -fx * sin + fy * cos;
          if ((lx/rx)**2 + (ly/ry)**2 <= 1) cov++;
        }
        if (cov > 0) this.set(px, py, r, g, b, Math.round(cov / 4 * 255));
      }
    }
  }

  // Filled rectangle
  fillRect(x, y, w, h, r, g, b, a = 255) {
    for (let py = Math.ceil(y); py < y + h; py++) {
      const rowA = Math.min(1, Math.min(py + 1, y + h) - Math.max(py, y)) * a;
      for (let px = Math.ceil(x); px < x + w; px++) {
        const colA = Math.min(1, Math.min(px + 1, x + w) - Math.max(px, x));
        this.set(px, py, r, g, b, Math.round(rowA * colA));
      }
    }
  }

  // Filled polygon (scan-line, AA edges)
  fillPolygon(pts, r, g, b) {
    const minY = Math.floor(Math.min(...pts.map(p => p[1])));
    const maxY = Math.ceil(Math.max(...pts.map(p => p[1])));
    for (let py = minY; py <= maxY; py++) {
      // sub-pixel coverage
      let cov = 0;
      for (let sy = 0; sy < 4; sy++) {
        const fy = py + (sy + 0.5) / 4;
        const xs = [];
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
          if ((y1 <= fy && fy < y2) || (y2 <= fy && fy < y1)) {
            xs.push(x1 + (fy - y1) / (y2 - y1) * (x2 - x1));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k < xs.length - 1; k += 2) {
          const left = xs[k], right = xs[k + 1];
          for (let px = Math.floor(left); px <= Math.ceil(right); px++) {
            const inside = Math.min(px + 1, right) - Math.max(px, left);
            if (inside > 0) {
              // accumulate coverage
              const existing = this._polyAA || {};
              const key = py * 100000 + px;
              existing[key] = (existing[key] || 0) + inside;
              this._polyAA = existing;
            }
          }
        }
      }
    }
    // flush coverage
    if (this._polyAA) {
      for (const [key, cov] of Object.entries(this._polyAA)) {
        const k = parseInt(key);
        const px = k % 100000, py = Math.floor(k / 100000);
        this.set(px, py, r, g, b, Math.round(Math.min(cov / 4, 1) * 255));
      }
      this._polyAA = null;
    }
  }

  // Cubic bezier fill helper — sample points along curve + fill polygon
  bezierPoints(p0, cp1, cp2, p3, steps = 60) {
    const pts = [];
    for (let t = 0; t <= 1; t += 1 / steps) {
      const u = 1 - t;
      pts.push([
        u**3*p0[0] + 3*u**2*t*cp1[0] + 3*u*t**2*cp2[0] + t**3*p3[0],
        u**3*p0[1] + 3*u**2*t*cp1[1] + 3*u*t**2*cp2[1] + t**3*p3[1],
      ]);
    }
    return pts;
  }

  // Rounded-rect fill (AA)
  fillRoundedRect(x, y, w, h, radius, r, g, b) {
    // body
    this.fillRect(x + radius, y, w - radius * 2, h, r, g, b);
    this.fillRect(x, y + radius, w, h - radius * 2, r, g, b);
    // corners
    this.fillEllipse(x + radius, y + radius, radius, radius, 0, r, g, b);
    this.fillEllipse(x + w - radius, y + radius, radius, radius, 0, r, g, b);
    this.fillEllipse(x + radius, y + h - radius, radius, radius, 0, r, g, b);
    this.fillEllipse(x + w - radius, y + h - radius, radius, radius, 0, r, g, b);
  }

  toPNG() { return encodePNG(this.w, this.h, this.buf); }
}

// ── Icon drawing ─────────────────────────────────────────────────────────────
function drawIcon(size) {
  const c = new Canvas(size, size);
  const s = size / 128;

  // ── Background ──
  c.fillRoundedRect(0, 0, size, size, Math.round(20 * s), 17, 17, 17);

  const [R, G, B] = [0, 255, 163]; // #00FFA3

  // ── Note head (oval, tilted ~-20°) ──
  // Centre slightly left and near bottom: (50, 88) at 128px
  const hcx = 50 * s, hcy = 88 * s;
  const hrx = 19 * s, hry = 14 * s;
  c.fillEllipse(hcx, hcy, hrx, hry, -0.35 /* ~-20° */, R, G, B);

  // ── Stem ── right edge of head up to top
  const stemX = 62 * s, stemTop = 22 * s, stemBot = 88 * s, stemW = 7 * s;
  c.fillRect(stemX, stemTop, stemW, stemBot - stemTop, R, G, B);

  // ── Flag (filled bezier shape) ──
  // Outer curve: from stem top-right, swing right, end at ~midpoint of stem
  const sx = stemX + stemW; // right edge of stem
  const flagEndY = 60 * s;
  const outerCurve = c.bezierPoints(
    [sx, stemTop],
    [sx + 32 * s, stemTop + 4 * s],
    [sx + 30 * s, flagEndY - 8 * s],
    [sx, flagEndY]
  );
  // Inner curve: reverse from flag end back to stem top (slightly tighter)
  const innerCurve = c.bezierPoints(
    [sx, flagEndY],
    [sx + 18 * s, flagEndY - 10 * s],
    [sx + 16 * s, stemTop + 6 * s],
    [sx, stemTop + 10 * s]
  ).reverse();

  const flagPts = [...outerCurve, ...innerCurve];
  c.fillPolygon(flagPts, R, G, B);

  return c.toPNG();
}

// ── Generate ──────────────────────────────────────────────────────────────────
const dir = __dirname;
for (const size of [16, 48, 128]) {
  const buf = drawIcon(size);
  const out = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(out, buf);
  console.log(`✓ icon${size}.png  (${buf.length} bytes)`);
}
console.log('Done.');

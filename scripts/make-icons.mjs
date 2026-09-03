#!/usr/bin/env node
/**
 * 生成桌面图标。零依赖 —— 自己拼 PNG，不引入 sharp/canvas 之类。
 *
 *   node scripts/make-icons.mjs
 *
 * 为什么不能只用现在那个 emoji SVG favicon：
 *   - iOS 「添加到主屏幕」只认 <link rel="apple-touch-icon"> 指向的 PNG，不认 SVG
 *   - Android 认 manifest 里的 icons，同样要位图
 * 所以这里出真正的 PNG。
 *
 * 画的是深色底 + 一条上扬的红色折线（红涨，和界面配色一致），
 * 细节刻意少 —— 32px 下还得看得清。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));

const BG = [0x16, 0x1b, 0x26];
const LINE = [0xf5, 0x55, 0x5f];
const SS = 4; // 超采样倍数，用来做抗锯齿

// 折线控制点，归一化坐标（y 向下）
const POINTS = [
  [0.10, 0.74],
  [0.29, 0.53],
  [0.43, 0.63],
  [0.61, 0.33],
  [0.76, 0.45],
  [0.91, 0.18],
];

const TARGETS = [
  { file: 'icon-512.png', size: 512, inset: 0 },
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0 },
  // maskable：Android 会把图标裁成各种形状，内容要缩进到安全区内
  { file: 'icon-maskable-512.png', size: 512, inset: 0.18 },
  { file: 'favicon-32.png', size: 32, inset: 0 },
];

// ⚠️ 生成放在文件末尾调用。下面的 CRC_TABLE 是 const，不会提升 ——
//    在这里直接跑循环会撞上 TDZ（Cannot access 'CRC_TABLE' before initialization）。
function main() {
  mkdirSync(OUT, { recursive: true });
  for (const t of TARGETS) {
    writeFileSync(join(OUT, t.file), encodePng(t.size, t.size, draw(t.size, t.inset)));
    console.log(`  ${t.file}  ${t.size}×${t.size}`);
  }
  console.log(`\n输出到 ${OUT}`);
}

/* ------------------------------------------------------------ 画图 */

function draw(size, inset) {
  const W = size * SS;
  const big = new Uint8Array(W * W * 3);

  // 背景铺满（maskable 的缩进只作用于内容，底色仍要铺满整块）
  for (let i = 0; i < W * W; i++) {
    big[i * 3] = BG[0];
    big[i * 3 + 1] = BG[1];
    big[i * 3 + 2] = BG[2];
  }

  const pad = inset * W;
  const span = W - pad * 2;
  const pts = POINTS.map(([x, y]) => [pad + x * span, pad + y * span]);
  const thickness = 0.075 * span;
  const half = thickness / 2;
  const bottom = pad + 0.88 * span;

  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      const idx = (py * W + px) * 3;

      // 折线下方的淡红色填充，给图标一点体量，小尺寸下不至于只剩一根细线
      const ly = lineYAt(pts, x);
      if (ly !== null && y > ly && y < bottom) blend(big, idx, LINE, 0.2);

      // 折线本身
      if (distToPolyline(pts, x, y) <= half) set(big, idx, LINE);
    }
  }

  // 末端加个圆点，强调「最新一点」
  const [ex, ey] = pts[pts.length - 1];
  const dotR = thickness * 0.95;
  for (let py = Math.max(0, (ey - dotR) | 0); py < Math.min(W, ey + dotR + 1); py++) {
    for (let px = Math.max(0, (ex - dotR) | 0); px < Math.min(W, ex + dotR + 1); px++) {
      if (Math.hypot(px + 0.5 - ex, py + 0.5 - ey) <= dotR) set(big, (py * W + px) * 3, LINE);
    }
  }

  return downsample(big, W, size);
}

function set(buf, idx, c) {
  buf[idx] = c[0];
  buf[idx + 1] = c[1];
  buf[idx + 2] = c[2];
}

function blend(buf, idx, c, a) {
  buf[idx] = buf[idx] * (1 - a) + c[0] * a;
  buf[idx + 1] = buf[idx + 1] * (1 - a) + c[1] * a;
  buf[idx + 2] = buf[idx + 2] * (1 - a) + c[2] * a;
}

/** 折线在给定 x 处的 y，超出范围返回 null */
function lineYAt(pts, x) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (x >= x1 && x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
  return null;
}

function distToPolyline(pts, x, y) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, distToSegment(x, y, pts[i], pts[i + 1]));
    if (best === 0) break;
  }
  return best;
}

function distToSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 超采样后的盒式降采样，就是抗锯齿 */
function downsample(big, bigSize, size) {
  const out = Buffer.alloc(size * size * 3);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * bigSize + (x * SS + sx)) * 3;
          r += big[i];
          g += big[i + 1];
          b += big[i + 2];
        }
      }
      const o = (y * size + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

/* ------------------------------------------------------------ PNG 编码 */

function encodePng(width, height, rgb) {
  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型 2 = truecolor RGB
  ihdr[10] = 0; // 压缩
  ihdr[11] = 0; // 滤波
  ihdr[12] = 0; // 隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

main();

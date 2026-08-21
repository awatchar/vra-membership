/**
 * Downscales an 8-bit RGBA PNG with Node's built-in zlib and nothing else.
 *
 * Written rather than pulled in as a dependency because it runs once, to produce
 * a committed asset. Adding a native image library to the project's devDeps for
 * a one-off would be a worse trade than sixty lines here.
 *
 * Alpha is premultiplied before averaging and divided back out afterwards.
 * Averaging straight RGBA darkens the edge of a transparent logo, because fully
 * transparent pixels carry an arbitrary colour that gets mixed in.
 */
import fs from 'node:fs';
import process from 'node:process';
import zlib from 'node:zlib';

function readChunks(buffer: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

/**
 * A byte, or 0 past the end.
 *
 * `noUncheckedIndexedAccess` is on across this repository, and it is right to
 * be: an out-of-range read here would otherwise become `undefined` and turn
 * every later arithmetic result into `NaN`, producing a black image rather than
 * an error.
 */
function at(buffer: Buffer, index: number): number {
  return buffer[index] ?? 0;
}

/** Reverses the per-scanline filters, returning tightly packed RGBA. */
function unfilter(raw: Buffer, width: number, height: number): Buffer {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = at(raw, y * (stride + 1));
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const target = out.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? at(target, x - bpp) : 0;
      const up = at(previous, x);
      const upLeft = x >= bpp ? at(previous, x - bpp) : 0;
      let value = at(line, x);

      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dLeft = Math.abs(p - left);
        const dUp = Math.abs(p - up);
        const dUpLeft = Math.abs(p - upLeft);
        value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }

      target[x] = value & 0xff;
    }
  }

  return out;
}

/** Box filter over the source rectangle each destination pixel maps to. */
function downscale(pixels: Buffer, width: number, height: number, edge: number): Buffer {
  const out = Buffer.alloc(edge * edge * 4);

  for (let y = 0; y < edge; y += 1) {
    const y0 = Math.floor((y * height) / edge);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / edge));

    for (let x = 0; x < edge; x += 1) {
      const x0 = Math.floor((x * width) / edge);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / edge));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * width + sx) * 4;
          const alpha = at(pixels, index + 3);
          // Premultiplied, so a transparent pixel contributes no colour.
          r += at(pixels, index) * alpha;
          g += at(pixels, index + 1) * alpha;
          b += at(pixels, index + 2) * alpha;
          a += alpha;
          count += 1;
        }
      }

      const target = (y * edge + x) * 4;
      const alpha = a / count;
      out[target + 3] = Math.round(alpha);
      if (a > 0) {
        out[target] = Math.min(255, Math.round(r / a));
        out[target + 1] = Math.min(255, Math.round(g / a));
        out[target + 2] = Math.min(255, Math.round(b / a));
      }
    }
  }

  return out;
}

/** Applies the Paeth filter, which compresses a logo's flat areas well. */
function filterUp(pixels: Buffer, edge: number): Buffer {
  const stride = edge * 4;
  const out = Buffer.alloc((stride + 1) * edge);

  for (let y = 0; y < edge; y += 1) {
    out[y * (stride + 1)] = 2; // Up
    for (let x = 0; x < stride; x += 1) {
      const above = y > 0 ? at(pixels, (y - 1) * stride + x) : 0;
      out[y * (stride + 1) + 1 + x] = (at(pixels, y * stride + x) - above) & 0xff;
    }
  }

  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const [source, destination, edgeArg] = process.argv.slice(2);
if (!source || !destination || !edgeArg) {
  throw new Error('Usage: node scripts/resize-png.ts <source> <destination> <edge>');
}
const edge = Number(edgeArg);
const buffer = fs.readFileSync(source);

const width = buffer.readUInt32BE(16);
const height = buffer.readUInt32BE(20);
if (buffer[24] !== 8 || buffer[25] !== 6 || buffer[28] !== 0) {
  throw new Error('Expected a non-interlaced 8-bit RGBA PNG');
}

const chunks = readChunks(buffer);
const raw = zlib.inflateSync(
  Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)),
);

const pixels = unfilter(raw, width, height);
const scaled = downscale(pixels, width, height, edge);

const header = Buffer.alloc(13);
header.writeUInt32BE(edge, 0);
header.writeUInt32BE(edge, 4);
header[8] = 8;
header[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  // No eXIf and no iTXt: the source carried both, and neither belongs in an
  // asset served to every visitor.
  chunk('IDAT', zlib.deflateSync(filterUp(scaled, edge), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(destination, png);
console.log(
  `${source} ${width}x${height} ${buffer.length}B -> ${destination} ${edge}x${edge} ${png.length}B`,
);

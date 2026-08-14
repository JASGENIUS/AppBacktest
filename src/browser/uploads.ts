/**
 * Deterministic upload-file generation. Same (seed, sizeKB) => identical
 * bytes, always a valid PNG (apps that sniff the signature accept it).
 * Padding rides in tEXt chunks so the target size is met without breaking
 * the format. Bump UPLOAD_GENERATOR_VERSION on any byte-affecting change.
 */

import { deflateSync } from "node:zlib";

export const UPLOAD_GENERATOR_VERSION = 1;

/** Tiny seeded LCG — deliberately independent of core/rng (pure module). */
function lcg(seedText: string): () => number {
  let s = 2166136261 >>> 0;
  for (let i = 0; i < seedText.length; i++) {
    s = Math.imul(s ^ seedText.charCodeAt(i), 16777619) >>> 0;
  }
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

export function generateUploadPng(seed: string, sizeKB: number): Buffer {
  const rand = lcg(`${seed}|${sizeKB}`);
  const W = 8;
  const H = 8;

  // IHDR: 8x8, 8-bit RGBA
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression/filter/interlace = 0

  // Raw scanlines: filter byte 0 + W*4 pixel bytes per row
  const raw = Buffer.alloc(H * (1 + W * 4));
  let off = 0;
  for (let y = 0; y < H; y++) {
    raw[off++] = 0;
    for (let x = 0; x < W * 4; x++) raw[off++] = rand() & 0xff;
  }
  const idat = deflateSync(raw);

  const parts: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
  ];

  // Pad with tEXt chunks (keyword "pad", printable latin1 body) up to target.
  const targetBytes = Math.max(1, sizeKB) * 1024;
  const baseLen = parts.reduce((n, b) => n + b.length, 0) + 12; // + IEND
  let remaining = targetBytes - baseLen;
  const MAX_TEXT = 32 * 1024;
  while (remaining > 30) {
    const bodyLen = Math.min(remaining - 16, MAX_TEXT);
    const body = Buffer.alloc(bodyLen);
    for (let i = 0; i < bodyLen; i++) body[i] = 32 + (rand() % 95);
    const data = Buffer.concat([Buffer.from("pad\0", "latin1"), body]);
    const c = chunk("tEXt", data);
    parts.push(c);
    remaining -= c.length;
  }

  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

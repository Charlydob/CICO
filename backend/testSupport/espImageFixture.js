import { createHash } from "node:crypto";
export function espImage(size = 512, chipId = 9) {
  const b = Buffer.alloc(size, 0x42);
  b.fill(0, 0, 32);
  b[0] = 0xe9;
  b[1] = 1;
  b[2] = 2;
  b[3] = 0x2f;
  b.writeUInt16LE(chipId, 12);
  b.writeUInt16LE(65535, 17);
  b[23] = 1;
  const length = Math.floor((size - 65) / 16) * 16;
  b.writeUInt32LE(chipId === 9 ? 0x3c000020 : 0x3f400020, 24);
  b.writeUInt32LE(length, 28);
  b.writeUInt32LE(0xabcd5432, 32);
  const end = 32 + length,
    checksumOffset = end | 15;
  b.fill(0, end, checksumOffset);
  let sum = 0xef;
  for (let i = 32; i < end; i++) sum ^= b[i];
  b[checksumOffset] = sum;
  createHash("sha256")
    .update(b.subarray(0, checksumOffset + 1))
    .digest()
    .copy(b, checksumOffset + 1);
  return b;
}

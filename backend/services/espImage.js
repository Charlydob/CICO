import { createHash } from "node:crypto";
import { otaError } from "./otaProtocol.js";
export function validateEspImage(bytes, chipId) {
  if (
    bytes.length < 288 ||
    bytes[0] !== 0xe9 ||
    bytes.readUInt16LE(12) !== chipId
  )
    throw otaError("Invalid ESP application image.");
  const segments = bytes[1];
  if (segments < 1 || segments > 16 || bytes[23] > 1)
    throw otaError("Invalid ESP image header.");
  let offset = 24,
    checksum = 0xef;
  for (let i = 0; i < segments; i++) {
    if (offset + 8 > bytes.length)
      throw otaError("Truncated ESP segment header.");
    const address = bytes.readUInt32LE(offset),
      length = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length)
      throw otaError("Invalid or truncated ESP segment.");
    if (i === 0 && (length < 256 || bytes.readUInt32LE(offset) !== 0xabcd5432))
      throw otaError("Application descriptor missing.");
    if (
      ((address >= 0x3c000000 && address < 0x3e000000) ||
        (address >= 0x42000000 && address < 0x44000000)) &&
      address % 65536 !== offset % 65536
    )
      throw otaError("ESP mapped segment alignment mismatch.");
    for (let j = offset; j < offset + length; j++) checksum ^= bytes[j];
    offset += length;
  }
  const checksumOffset = offset | 15;
  if (checksumOffset >= bytes.length || bytes[checksumOffset] !== checksum)
    throw otaError("ESP image checksum mismatch.");
  const end = checksumOffset + 1;
  if (bytes[23]) {
    if (end + 32 !== bytes.length)
      throw otaError("ESP image digest length mismatch.");
    const hash = createHash("sha256").update(bytes.subarray(0, end)).digest();
    if (!hash.equals(bytes.subarray(end, end + 32)))
      throw otaError("ESP image validation hash mismatch.");
  } else if (end !== bytes.length)
    throw otaError("Unexpected ESP image trailing bytes.");
  return { segments, imageBytes: bytes.length, appendedHash: bytes[23] === 1 };
}

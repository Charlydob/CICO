import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { hardwareSpec, otaError } from "./otaProtocol.js";

export function createFirmwareStorage(
  root = process.env.FIRMWARE_DIR ||
    path.join(process.env.DATA_DIR || "backend/data", "firmware"),
) {
  root = path.resolve(root);
  function filePath(key) {
    if (!/^[a-f0-9-]{36}\.bin$/.test(key))
      throw otaError("Invalid firmware storage key.");
    return path.join(root, key);
  }
  return {
    async save(request, model) {
      const limit = hardwareSpec(model).otaSlotBytes;
      const length = request.headers["content-length"];
      if (length && (!/^\d+$/.test(length) || Number(length) > limit))
        throw otaError("Firmware exceeds the 1792 KiB OTA slot.", 413);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const key = `${randomUUID()}.bin`,
        temp = `${filePath(key)}.upload`;
      const handle = await open(temp, "wx", 0o600);
      let size = 0;
      let prefix = Buffer.alloc(0);
      const hash = createHash("sha256");
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > limit)
            throw otaError("Firmware exceeds the 1792 KiB OTA slot.", 413);
          if (prefix.length < 36)
            prefix = Buffer.concat([
              prefix,
              chunk.subarray(0, 36 - prefix.length),
            ]);
          hash.update(chunk);
          // FileHandle.write can write fewer bytes than requested.
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset);
            offset += bytesWritten;
          }
        }
        // ESP32-S3 image header + first segment's esp_app_desc_t magic.
        // Bootloaders/merged USB images do not have this application descriptor here.
        if (
          size < 288 ||
          prefix[0] !== 0xe9 ||
          prefix.readUInt16LE(12) !== 9 ||
          prefix.readUInt32LE(32) !== 0xabcd5432
        ) {
          throw otaError(
            "Not an ESP32-S3 application image; upload firmware.bin only.",
          );
        }
        if (length && Number(length) !== size)
          throw otaError("Incomplete firmware upload.");
        await handle.sync();
        await handle.close();
        await rename(temp, filePath(key));
        return { storagePath: key, fileSize: size, sha256: hash.digest("hex") };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temp).catch(() => {});
        throw error;
      }
    },
    async get(release) {
      const file = filePath(release.storagePath),
        info = await stat(file).catch(() => {
          throw otaError("Firmware artifact is unavailable.", 503);
        });
      if (!info.isFile() || info.size !== release.fileSize)
        throw otaError("Firmware artifact is damaged.", 503);
      return file;
    },
    async remove(key) {
      await unlink(filePath(key)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

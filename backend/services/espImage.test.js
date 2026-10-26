import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateEspImage } from "./espImage.js";
import { espImage } from "../testSupport/espImageFixture.js";
test("ESP image validates segments, padding/checksum and appended hash; rejects corruption beyond prefix", () => {
  const good = espImage();
  assert.equal(validateEspImage(good, 9).segments, 1);
  let bad = Buffer.from(good);
  bad[350] ^= 1;
  assert.throws(() => validateEspImage(bad, 9), /checksum/);
  bad = Buffer.from(good);
  bad[511] ^= 1;
  assert.throws(() => validateEspImage(bad, 9), /hash/);
  assert.throws(() => validateEspImage(good.subarray(0, 500), 9));
  bad = Buffer.from(good);
  bad.writeUInt32LE(0xfffffffc, 28);
  assert.throws(() => validateEspImage(bad, 9), /segment/);
  bad = Buffer.from(good);
  bad.writeUInt32LE(0x3c000024, 24);
  assert.throws(() => validateEspImage(bad, 9), /alignment/);
  assert.throws(() => validateEspImage(good, 0));
});
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createFirmwareStorage } from "./firmwareStorage.js";
test("firmware distribution rejects same-size tampering after upload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ota-integrity-")),
    storage = createFirmwareStorage(root);
  try {
    const b = espImage(),
      req = Readable.from([b]);
    req.headers = {};
    const a = await storage.save(req, "CROWPANEL_7_V3");
    b[350] ^= 1;
    await writeFile(path.join(root, a.storagePath), b);
    await assert.rejects(
      storage.get({ ...a, hardwareModel: "CROWPANEL_7_V3" }),
      /SHA-256/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Run on the private backend host with DATABASE_URL set. No token is printed.
import { open } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { createOtaService } from "../services/otaService.js";
import { createFirmwareStorage } from "../services/firmwareStorage.js";

const [deviceId, output] = process.argv.slice(2);
if (!deviceId || !output?.endsWith(".device-provisioning.json")) {
  console.error(
    "Usage: node backend/scripts/provisionDevice.js <device-id> <private-path>.device-provisioning.json",
  );
  process.exit(1);
}
const origin = process.env.OTA_PUBLIC_ORIGIN || process.env.APP_ORIGIN;
if (!origin || new URL(origin).protocol !== "https:") {
  console.error(
    "Configure OTA_PUBLIC_ORIGIN=https://your-cico-host before provisioning.",
  );
  process.exit(1);
}
const prisma = new PrismaClient();
let handle;
try {
  // Fail before rotating if the destination already exists. umask/mode keep the token private.
  handle = await open(output, "wx", 0o600);
  const device = await prisma.device.findUnique({ where: { deviceId } });
  if (!device) throw new Error("Device not registered.");
  const credentials = await createOtaService(
    prisma,
    createFirmwareStorage(),
  ).rotateCredential(device.id);
  await handle.writeFile(
    JSON.stringify(
      {
        ...credentials,
        base_url: origin,
        hardware_model: device.hardwareModel,
      },
      null,
      2,
    ) + "\n",
  );
  await handle.sync();
  console.log(
    "Device credential rotated; provisioning file saved with mode 0600. Transfer it securely into device NVS.",
  );
} catch {
  console.error(
    "Provisioning failed. Inspect device registration, database access and destination permissions; retry with a new private output file.",
  );
  process.exitCode = 1;
} finally {
  await handle?.close();
  await prisma.$disconnect();
}

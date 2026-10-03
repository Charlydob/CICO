# CheckoutBox V1: CICO provisioning and validation

This change is additive. Existing `CROWPANEL_7_V3` registration, firmware compatibility, commands and health checks remain unchanged.

## Provision `checkoutbox-lab-01`

1. Apply the normal Prisma production migration workflow (do not use `db push`):

   ```sh
   npx prisma migrate deploy
   ```

2. As Platform Admin, open **Devices / Firmware**, register:

   - Name: `CheckoutBox Lab 01`
   - Device ID: `checkoutbox-lab-01`
   - Hardware: `ESP32_DEVKIT_CHECKOUT_V1`
   - Hotel: the intended tenant, or Unassigned / Lab

3. On the private CICO backend host, with `DATABASE_URL` and `OTA_PUBLIC_ORIGIN=https://...` configured, create the one-time provisioning file:

   ```sh
   node backend/scripts/provisionDevice.js checkoutbox-lab-01 /data/private/checkoutbox-lab-01.device-provisioning.json
   ```

   The file is created with mode 0600 and contains the HTTPS base URL and the individual 64-hex token. It must never be committed, pasted into logs, or bundled into firmware.

4. First-flash the ESP32 over USB. Join `CheckoutBox-Setup` (password `checkoutbox-v1`), then enter Wi-Fi, `base_url`, and `token` from the private file. The fixed device ID is already compiled as `checkoutbox-lab-01`.

5. Wait for ONLINE. Open device details and save Closed/Open/Hold once. Configuration is versioned and returned on polling until the device heartbeats the matching `config_version`.

6. Upload only the `.pio/build/esp32dev/firmware.bin` application artifact as hardware `ESP32_DEVKIT_CHECKOUT_V1`. The server enforces the 1792 KiB slot limit and hardware match.

## Safe physical validation order

Keep the MG90S horn disconnected for initial angle calibration. Validate UART raw frames first, then closed/open angles, then fit the horn and run Test. Add the observed UID to `allowedRfids` before expecting an offline RFID cycle. Finally test Internet loss during RFID reads and servo motion, followed by OTA success and an intentionally failed health boot to confirm rollback.

No production deployment or device flash is performed by this repository change.

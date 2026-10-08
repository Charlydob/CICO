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

## Manual SG90 diagnostic

Only Platform Admin users can open **Devices / Firmware** and access the CheckoutBox controls. Select a duration of 10, 30, 60 or 120 seconds and press **INICIAR TEST**. The device cycles `10 -> 90 -> 170 -> 90`, one position per second, without blocking RFID, Wi-Fi, CICO or OTA communications. Press **DETENER TEST** for the priority stop command. The device returns to its configured closed angle after stop or timeout.

The status is reported by heartbeat as Inactive, Running, Completed or Error. A command acknowledgement only confirms that the firmware accepted and issued the PWM position command; the SG90 has no position feedback and CICO must not present the ACK as proof of physical movement.

RFID allowlists use the same contract as the firmware: at most 128 entries, each
exactly 8 hexadecimal characters. For the 10-byte EM4100 UART frame, the
firmware keeps the four UID bytes after the hidden byte (for example,
`02 0A 02 2E 00 B6 D7 B5 F2 03` becomes `00B6D7B5`). The hidden byte and BCC
are not part of the allowlist value. Invalid lengths are rejected instead of
being silently truncated or converted.

The same operation is available locally at 115200 baud:

```text
servo test 60
servo stop
```

Durations outside 10-120 seconds are rejected. The diagnostic is always inactive after reboot and never starts automatically. Normal servo movements and calibration writes are rejected while the diagnostic is running. STOP supersedes an already pending device command.

## Safe physical validation order

Keep the SG90 horn disconnected for initial angle calibration. Verify 5 V at the servo connector under load, continuity of GPIO18 to the signal pin, and common ground before starting a diagnostic. Validate UART raw frames on GPIO23 first, then closed/open angles, then fit the horn and run the manual test. Add the observed UID to `allowedRfids` before expecting an offline RFID cycle. Finally test Internet loss during RFID reads and servo motion, followed by OTA success and an intentionally failed health boot to confirm rollback.

No production deployment or device flash is performed by this repository change.

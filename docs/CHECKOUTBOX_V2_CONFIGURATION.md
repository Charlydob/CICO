# CheckoutBox V2 configuration audit

## Live, persisted, and safe

The following values are stored in PostgreSQL, delivered by the authenticated
device protocol, validated and stored in ESP32 NVS, and applied without reboot:

- RFID authorizations (8 or 10 hexadecimal characters, maximum 128)
- closed and open servo angles (10–170 degrees and never equal)
- open hold time (100–30,000 ms)
- duplicate RFID suppression (250–10,000 ms)
- repeated activation protection (0–30,000 ms)
- progressive servo movement (0–100 ms per degree; 0 is immediate)
- heartbeat (10–120 s) and CICO poll interval (5–120 s)
- detailed diagnostic enablement and automatic timeout (30–900 s)
- startup behavior (`CLOSED` or `KEEP_LAST`)
- connection-loss behavior (`KEEP_LOCAL` or `CLOSE`)

CICO stores desired and last confirmed applied configuration separately. The
firmware reports a checksum calculated from the actual in-memory values plus the
UID count. CICO resends when version, checksum, or count differs. The firmware
rejects older versions and invalid checksums while retaining the last valid copy.

## Controlled reboot

Wi-Fi credentials, the CICO HTTPS base URL and the per-device credential are
provisioning settings. Changing them requires the captive portal and a controlled
reconnect/reboot. They are deliberately not exposed in the web administration UI.

## Firmware-only

GPIO routing, UART number/format, PWM frequency and pulse bounds, partition
layout, TLS root CAs, hardware model and OTA slot size remain compile-time values.
Changing them remotely could prevent boot, damage hardware, or break recovery.

## Diagnostic stream

Events are authenticated, allowlisted, queued in a bounded 32-entry RAM buffer on
the ESP32, posted in bounded batches, and retained up to 1,000 events per device
in CICO. Wi-Fi secrets and tokens are never event fields. The UI polls every five
seconds and labels events received after the panel opened as live; it is remote
telemetry rather than direct serial-port access.

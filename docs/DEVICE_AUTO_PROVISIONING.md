# Automatic device provisioning

Checkout Box firmware 1.4.0 derives a permanent technical identity from the
ESP32 station MAC (`checkoutbox-<12 lowercase hex digits>`). The display name
and hotel assignment remain independent CICO fields.

The new flow is additive. Existing devices and `/api/device/v1/*` credentials
are unchanged.

1. The unprovisioned device creates a 256-bit bootstrap token and an 8-digit
   physical pairing code in NVS.
2. After Wi-Fi and TLS are available it calls
   `POST /api/provisioning/v1/discover`. CICO stores only hashes and lists the
   unit as pending; no active device, checkout, notification or command exists.
3. A platform administrator reads the code from the local setup portal or USB
   serial output, chooses a name and hotel, and approves the discovery.
4. CICO creates the device and an individual credential. The device retrieves
   it with its 256-bit bootstrap token during a bounded 15-minute delivery
   window and stores it in NVS.
5. Normal authenticated heartbeats and configuration begin only after that.

`PROVISIONING_MASTER_KEY` must be 64 random hexadecimal characters and must be
present only in the backend environment. If it is missing or invalid, every
automatic-provisioning endpoint fails closed with HTTP 503. Generate it with a
cryptographically secure secrets manager and back it up before deployment.

The discovery protocol accepts product-prefixed MAC identities for Checkout Box
and Hookbox. Hardware-specific behavior remains selected by `hardware_model`, so
future Hookbox firmware can reuse this flow without sharing device credentials.

## Safe deployment order

1. Back up PostgreSQL and verify restore instructions.
2. Set `PROVISIONING_MASTER_KEY` without changing existing device secrets.
3. Apply the additive migration `20261108170000_device_auto_provisioning`.
4. Deploy backend and frontend; verify existing devices still heartbeat.
5. Flash a new Checkout Box only after the pending-device endpoints return 200.
6. Pair it using the physical code. Never reuse or rotate Checkout Box 1.

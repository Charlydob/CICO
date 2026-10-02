# Hookbox OTA — CICO infrastructure and device protocol v1

## Delivery state

Implemented in `feature/hookbox-ota`: Platform Admin UI, persistent device/release/update models, migration, per-device authentication, heartbeat, metadata polling, restricted binary download, state/event tracking, safe release deletion, allowlisted commands, provisioning utility and server tests.

**The physical end-to-end acceptance is NOT complete.** The stable firmware source is now integrated separately in `Charlydob/HOOKBOX-FIRMWARE` branch `feature/cico-ota-client`, based directly on tag `v2.3.0-hmi4`. Real Build A/B application images, checksums, release automation and the device-side client have been produced. No hardware was flashed or exercised here, so neither physical display/touch behavior nor OTA/rollback success is claimed. Server tests still use synthetic ESP32-S3 bytes and authenticated simulated reports; the firmware repository runbook is authoritative for the lab procedure.

## Deployment

No production credentials/deployment access were configured in this environment. Production has not been changed. Preserve the existing CICO deployment, database and volume names.

1. Back up PostgreSQL and the existing `app-data` volume using the current server's backup procedure. Inspect the additive migration `prisma/migrations/20261001230000_hookbox_ota/migration.sql`: it creates five tables, enum, relations, indexes and constraints in a transaction; it does not alter/delete existing hotel rows. Confirm sufficient disk space.
2. Check out this feature branch in a staging checkout. Use Node 22+; run `npm ci`, `npx prisma generate`, `npm test`, `npm run build`. Configure a **disposable migrated** PostgreSQL database to run OTA integration tests via `OTA_POSTGRES_TEST_DATABASE_URL`. Never point tests at production.
3. Keep existing `DATABASE_URL`, `SESSION_SECRET`, `APP_ORIGIN` and bootstrap configuration. Add the variables below. Run `npx prisma migrate deploy` against staging first. The backend image already runs migrations at startup.
4. Build using the existing Dockerfiles and deployment Compose file. For Hetzner: `docker compose -f docker-compose.hetzner.yml build backend frontend` and `docker compose -f docker-compose.hetzner.yml up -d backend frontend`, only in the intended staging stack. Use the existing stack/network/volume names; a different Compose project name creates different volumes.
5. Verify `/api/health`, existing hotel functionality, Platform Admin access and HTTPS device endpoints. Non-admins must receive 401/403 and must not see Devices / Firmware.
6. Ensure the public reverse proxy routes `/api/*` to the private backend and supplies `X-Forwarded-Proto: https`. In the generic stack, the bundled Caddy does this. In Hetzner, the external proxy handles `/api`; `Caddyfile.hetzner` serves frontend files only. Keep backend port 3001 bound to loopback/private network. Never expose a trusted-proxy backend directly to the Internet.
7. Firmware lives in `/data/firmware`, on the **existing `app-data` named volume**. Back up that directory together with PostgreSQL. Do not use `docker compose down -v`. A container rebuild/recreation must not delete the volume. For multiple backend replicas, all replicas must mount the same shared storage; a different local volume per host does not work.
8. After staging acceptance and source review, deploy with the same existing production procedure. The existing `.github/workflows/deploy.yml` automatically deploys pushes to `main`; merging this branch would therefore trigger production deployment. Keep the PR in draft until firmware integration and the physical acceptance are complete. Do not merge into main until validated. To roll back CICO code, retain the new tables and volume: the additive schema is compatible with the previous application. Do not run destructive down-migrations.

### Environment variables

| Variable | Production value / meaning |
| --- | --- |
| `OTA_PUBLIC_ORIGIN` | `https://your-cico-host` (defaults to `APP_ORIGIN`) |
| `FIRMWARE_DIR` | `/data/firmware`; both Compose files configure it on persistent `/data` |
| `OTA_TRUST_PROXY` | `true` only behind the private, trusted reverse proxy; default false outside Compose |
| `OTA_DEV_ALLOW_HTTP` | Optional `true` for explicit local development only; ignored in production; not set in Compose |
| `OTA_POSTGRES_TEST_DATABASE_URL` | Disposable migrated DB for integration tests; never set in production |
| `CICO_FIRMWARE_PUBLISH_TOKEN` | Dedicated random CI publisher token (minimum 32 characters); grants release publication only, never device deployment |

`CICO_FIRMWARE_PUBLISH_TOKEN` must also be stored as a GitHub Actions secret in `Charlydob/HOOKBOX-FIRMWARE`, together with `CICO_BASE_URL`. Rotate it by changing the backend environment value and the repository secret. It is independent of browser sessions, personal passwords and device credentials.

## CI firmware publication

`POST /api/ci/v1/firmware-releases` accepts the same validated application binary and metadata as the Platform Admin upload. It requires HTTPS, `Authorization: Bearer <CICO_FIRMWARE_PUBLISH_TOKEN>`, `Content-Type: application/octet-stream` and `X-Firmware-Sha256`. The backend streams and validates the ESP32-S3 application, size, hardware, duplicate version/build and server-computed SHA before publishing. Authentication happens before reading firmware bytes.

This endpoint has exactly one capability: creating a Firmware Release. It cannot create devices, rotate credentials, assign an update or administer CICO. Therefore a successful GitHub release makes firmware visible to Platform Admin but never performs a global or per-device deployment.

Local browser development: `APP_ORIGIN=http://127.0.0.1:5173 OTA_DEV_ALLOW_HTTP=true NODE_ENV=development`, existing DB/session variables, backend on 3001, `npm run dev` using the existing Vite `/api` proxy. The firmware's production transport must always use HTTPS and CA validation regardless of this server-side local flag.

## Register/provision the physical CrowPanel

1. As Platform Admin, open **Devices / Firmware → Devices → Register device**. Use a stable unique ID (e.g. `hookbox-lab-<unique-suffix>`), name `Hookbox Lab`, model `CROWPANEL_7_V3` and optional hotel. The device is initially unprovisioned/offline. Tenant relation uses the existing hotel-as-tenant architecture.
2. On the private backend host/container with its existing `DATABASE_URL` and `OTA_PUBLIC_ORIGIN`, run:

   ```sh
   node backend/scripts/provisionDevice.js hookbox-lab-UNIQUE /private/hookbox-lab.device-provisioning.json
   ```

   Under Compose the image includes that script; select the existing backend service/container and a private writable destination (for example `/data/private`, created with mode 0700). The script creates a new file with mode 0600 and refuses to overwrite one. It prints no token. Each invocation rotates the device's credential and invalidates the old one. Failure after rotation may require repeating with a new private output path. The UI exposes only configured/revoked state, never the token/hash.
3. Transfer that file securely to the physical provisioning station. It contains `device_id`, `hardware_model`, `base_url`, `token` and `credential_version`. Use the firmware repository's `tools/provision_cico_serial.py`; it validates the file, sends it over the physical USB serial link without printing the token and stores the identity in dedicated NVS keys. Do not put secrets in Git, release notes, screenshots, build flags or logs. Provisioning secrets are not embedded in published firmware.bin.
4. Store Wi-Fi preferences, device credentials, UI manifest/cache and configuration independently from application OTA slots. Never erase NVS during the last USB flash or an OTA. Keep the physically validated partition table unchanged.
5. For rotation, run the same utility into a new private file and securely reprovision that specific device. This iteration prepares manual rotation; automatic remote credential rotation is not implemented. For revocation, use Device Details → Revoke credential. Revoked tokens cannot heartbeat, poll, report or download.

Tokens contain 256 random bits; PostgreSQL stores their SHA-256 hash only. Device authorization is independent of CICO user/session and tenant authentication.

## Device wire protocol

All device requests carry these headers, never query parameters:

```text
X-Device-Id: hookbox-lab-UNIQUE
Authorization: Bearer <64-hex-individual-token-from-NVS>
```

Use HTTPS, correct hostname and CA validation. Synchronize time before TLS if required by the ESP stack. Do not use `setInsecure()` or skip certificate verification. Never follow redirects that could send credentials to another host. Build a transport adapter so polling can later become MQTT/WebSocket without changing installation/health logic.

### Heartbeat

`POST /api/device/v1/heartbeat`, `Content-Type: application/json`, approximately every 20–30 seconds from a background task:

```json
{
  "device_id": "hookbox-lab-UNIQUE",
  "hardware_model": "CROWPANEL_7_V3",
  "firmware_version": "2.4.0",
  "build_id": "20261002.ota-base",
  "config_version": "1",
  "uptime": 120,
  "rssi": -55,
  "local_ip": "192.168.1.123",
  "free_heap": 100000,
  "psram": 4000000,
  "last_reset_reason": "POWERON",
  "last_ota_result": null
}
```

Uptime/heap/PSRAM are nonnegative 32-bit integers; PSRAM is available bytes. Reset reason is bounded text; OTA results are bounded uppercase diagnostic codes. No SSID/password. The server allowlists fields and does not persist arbitrary extra diagnostics. Online is derived from last contact <90 seconds; it is not a stale database flag. OTA reports also refresh lastSeenAt. A heartbeat alone does not confirm OTA success.

### Polling / START_UPDATE

`GET /api/device/v1/update` every 20 seconds without blocking LVGL. Empty response:

```json
{"protocol_version":1,"poll_after_seconds":20,"command":null,"update":null}
```

When Platform Admin selects a compatible newer release and presses START UPDATE:

```json
{
  "protocol_version": 1,
  "poll_after_seconds": 20,
  "command": null,
  "update": {
    "request_id": "<uuid>",
    "status": "PENDING",
    "version": "2.4.1",
    "build_id": "20261002.ota-test",
    "hardware_model": "CROWPANEL_7_V3",
    "file_size": 1500000,
    "sha256": "<server-computed-64-hex>",
    "signature": null,
    "download_path": "/api/device/v1/updates/<uuid>/firmware"
  }
}
```

`START_UPDATE` is represented by the durable request, not a separate transient command. One active request per device is enforced by a PostgreSQL advisory lock and partial unique index. Devices can be offline at assignment; the request remains pending until polled. No timeout fabricates failure/success: UI says awaiting confirmation after 10 minutes without update progress. Admins cannot enqueue RESTART/CHECK_UPDATE during an active OTA.

The firmware must validate metadata, same compiled hardware model, newer numeric version, allowed file size and the actual inactive slot capacity. Both application version and build ID must be compiled into the app and reported truthfully. Server metadata is entered by an authorized publisher; it is not extracted from a firmware project that was unavailable. The server checks ESP32-S3 image chip ID and application descriptor, rejecting bootloader/merged USB binaries; it cannot prove the publisher's claimed board model/version for arbitrary images.

### Download / verification / installation — implemented firmware contract

1. Keep UI responsive with a separate OTA/network task; communicate overlay state to the LVGL task using its existing synchronization discipline.
2. Persist the request ID, previous version/build, expected version/build and OTA phase in a dedicated NVS namespace before reboot. Do not repeatedly write every percentage to NVS.
3. Fetch `base_url + download_path` with the same individual authentication headers. Only same-origin HTTPS paths from the protocol are allowed. Validate Content-Length/total bytes against metadata and actual slot size. Do not install on truncation, SHA mismatch, metadata mismatch or TLS failure.
4. Begin ESP-IDF OTA on `esp_ota_get_next_update_partition(NULL)`; ensure it is not the running partition. Stream chunks into the **inactive application partition** and SHA-256 context while downloading. Writing the inactive partition before the final hash comparison is normal streaming OTA; never select it as boot partition until hash and image validation succeed. Abort on error and leave the active app intact.
5. After exact SHA-256 match, finalize `esp_ota_end`, set boot partition, persist REBOOTING and restart. Slots remain ota_0/ota_1, each 1792 KiB. Do not deliver bootloader/partition table over this API.
6. On new boot, detect `ESP_OTA_IMG_PENDING_VERIFY`, report HEALTH_CHECK when possible and run the actual stable app's health conditions: boot, configuration, display, LVGL, touch, Wi-Fi stack and main READY. Mark valid with `esp_ota_mark_app_valid_cancel_rollback()` only after all checks pass. Wi-Fi **stack** init is a local health condition; do not roll back merely because Internet is temporarily down.
7. Persist success evidence after marking valid, retry reporting until CICO acknowledges, then clear the pending report. If the app crashes between marking valid and saving the report, recover from the durable request ID/expected version plus valid running image; do not lose completion forever. An acknowledged report can be replayed safely. The previous validated image must use this same reconciliation protocol.
8. If health fails, use the SDK's valid rollback mechanism. On previous app boot, confirm the bootloader/image evidence of rollback, restore normal UI/network, read the durable request ID and send ROLLED_BACK. Do not infer rollback solely because the current version differs from target. Keep pending rollback reporting until acknowledged.
9. Admin overlay states: Updating system / Downloading XX% / Verifying / Installing / Restarting. No guest cancel action; no tokens/URLs shown. Preserve guest functions outside the update operation. Keep all actuators MOCK, no HIL/RFID/solenoids/MG90S.

These steps are implemented in the firmware feature branch but remain **physically unvalidated** until the lab acceptance below is performed.

### Progress/result reports

`POST /api/device/v1/update/status`, JSON:

```json
{"request_id":"<uuid>","status":"DOWNLOADING","progress":37}
```

States: PENDING (created by server), DOWNLOADING, VERIFYING, INSTALLING, REBOOTING, HEALTH_CHECK, SUCCESS, FAILED, ROLLED_BACK. Reports can skip forward after a network gap; active phases/progress cannot move backwards. Progress may reset for a new phase. Requests are scoped to the authenticating device. Persist diagnostic codes, never exception strings containing tokens or URLs.

SUCCESS:

```json
{
  "request_id": "<uuid>",
  "status": "SUCCESS",
  "firmware_version": "2.4.1",
  "build_id": "20261002.ota-test",
  "health_check": {
    "boot": true, "config": true, "display": true, "lvgl": true,
    "touch": true, "wifi_stack": true, "ready": true, "app_valid": true
  }
}
```

FAILED example (before selecting a new boot image):

```json
{"request_id":"<uuid>","status":"FAILED","result_code":"SHA256_MISMATCH"}
```

ROLLED_BACK:

```json
{
  "request_id":"<uuid>", "status":"ROLLED_BACK", "rolled_back":true,
  "firmware_version":"2.4.0", "build_id":"20261002.ota-base",
  "result_code":"BOOT_VALIDATION_FAILED"
}
```

Rollback must match the previous version/build captured by CICO at assignment. Terminal results are idempotent/immutable. For post-boot health failure, send ROLLED_BACK from the restored app, not a terminal FAILED before rolling back. Device firmware must not report DOWNLOADING again on reboot for a request already in REBOOTING/HEALTH_CHECK; reconcile the persisted attempt and report the final result.

### CHECK_UPDATE / RESTART

Admin Device Details can queue CHECK_UPDATE or RESTART, delivered as `command:{id,type,expires_at}` by polling (5-minute lifetime). No shell, arbitrary URLs or arbitrary remote function names.

Firmware must persist command IDs to prevent repeated restart, acknowledge with `POST /api/device/v1/commands/ack`, JSON `{"command_id":"<uuid>"}` and execute at most once. Acknowledgement records receipt, not proof of reboot; a subsequent heartbeat/reset diagnostic shows the reboot. CHECK_UPDATE means perform an immediate poll. Expired commands are not delivered. Normal OTA uses the assigned update request above.

## First physical acceptance — ready for the lab device

The implementation branch starts directly at stable tag `v2.3.0-hmi4`, keeps `crowpanel_ota_4mb.csv` and compiles with the ESP32-S3 rollback SDK option enabled. The firmware repository runbook records tests, artifact hashes and the parameterized USB command.

1. Review both PRs and obtain the two generated application binaries. Confirm each with its supplied SHA-256 and manifest; do not use a bootloader, partition-table or merged image as an OTA artifact.
2. Build A is 2.4.0 / 20261002.ota-base with all actuators MOCK. Build B is 2.4.1 / 20261002.ota-test and adds only the visible `OTA TEST 2.4.1` label. Both use identical partitions and must remain <=1,835,008 bytes.
3. Flash Build A with the documented `crowpanel_ota_base` PlatformIO upload command and the actual COM port. Never run an erase target. Provision its individual CICO credential over USB serial, then retain NVS through every OTA.
4. Flash A once by USB, configure Wi-Fi, verify reconnect across reboot and preserved SSID/device token/config/UI cache. Wait for ONLINE in CICO and verify version/build A and diagnostics.
5. Upload B's firmware.bin in Firmware Releases, enter B version/build, CROWPANEL_7_V3 and notes. Compare the server SHA with the artifact SHA.
6. Devices → Hookbox Lab → Update → select B → START UPDATE. Observe download overlay/progress, verification, installation and restart. Confirm B's visible label and truthful heartbeat/version/build. CICO must show HEALTH_CHECK/SUCCESS only after device confirmation.
7. Reboot B once more and verify Wi-Fi/identity/UI/MOCK still work. Preserve logs/screenshots without secrets and record both artifact SHA values. Only then mark physical acceptance complete.

## Controlled rollback acceptance

Use a lab CrowPanel after A/B success with a known valid previous slot, unchanged partition table and working USB recovery. Do not deploy failure builds to hotel devices.

Create a MOCK test-only build with a **newer version** (e.g. 2.4.2 / 20261002.ota-rollback-test) and an explicit off-by-default test flag. It should detect PENDING_VERIFY, deliberately decline health validation and trigger the SDK's rollback safely; do not exercise actuators or corrupt flash/NVS. No such binary was generated here.

Publish/assign the test release. Observe reboot into the test image, validation rejection, rollback into B, reconnect and a durable ROLLED_BACK report with B version/build and diagnostic. CICO must preserve the failed attempt/history and previous version. Verify NVS preferences unchanged. Remove the flag from normal builds. The SDK rollback bootloader configuration must be verified with the stable project's actual files before running this test.

Automated server integration tests already validate acceptance/rejection of rollback reports and restoration of previous reported version. They do not validate ESP flash/bootloader rollback.

## Security and operational limits

- HTTPS + individual bearer authentication + server SHA-256 are implemented on CICO and enforced by the device client with validated public CA roots, same-origin download paths, exact size/hardware checks and inactive-slot streaming. No release signature is implemented; `signature` is explicitly null. Next hardening: server signing with private key in secret infrastructure and compiled device public key, with a defined signed payload/algorithm. SHA over authenticated HTTPS is integrity checking, not a firmware signature.
- No secure boot/flash encryption, anti-rollback fuse policy or remote attestation is claimed. A compromised authenticated device can lie about diagnostics/health; the server validates report structure and compatibility, not physical state.
- Server checks image type/chip but authorized publisher must supply accurate board/version/build metadata. Add a firmware-generated manifest or signed embedded metadata when the stable source permits it.
- Device tokens are persisted hashed and never returned by browser endpoints. Manual provisioning files are sensitive and must be securely handled and removed from the station after verified provisioning.
- Uploads are streamed, size bounded and stored outside Git in persistent storage. Failed uploads clean partial files. A host crash mid-upload may leave an unreferenced `.upload`/`.bin`; cleanup must reconcile with PostgreSQL and avoid active transfers. Fleet-wide disk quota/object storage lifecycle policy is future work.
- Normal OTA changes application slots only; UI configuration is separate. Fleet requests are one row per device, ready for later selected/all-compatible/canary scheduling; no fleet rollout UI yet.
- First iteration does not automatically retry FAILED attempts or cancel an unknown/stalled installation. Diagnose the device before administrative recovery; never mark an unconfirmed update SUCCESS.

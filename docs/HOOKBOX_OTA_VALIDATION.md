# OTA validation report — 2026-10-02

Scope: CICO infrastructure on `feature/hookbox-ota`, based on `78824bc1b64061deeff503d001604a8f1340cba6`. No production deploy, physical flashing or ESP firmware changes.

## Executed checks

| Check | Result |
| --- | --- |
| `npm ci` | PASS |
| `prisma validate` / `prisma generate` | PASS |
| `prisma migrate deploy` into disposable PostgreSQL 16 | PASS — all eleven migrations |
| Upgrade from pre-OTA schema with sentinel user and existing hotel | PASS — existing rows retained; new tables initially empty |
| OTA protocol/storage tests | PASS — seven tests |
| PostgreSQL/HTTP OTA integration + provisioning CLI | PASS — eleven tests including the parent test |
| Entire `npm test` with both PostgreSQL integration flags | **119 pass / 1 existing failure / 0 skipped** |
| Same failing checkout test on original commit `78824bc` | Same 404 vs expected 410 at `checkoutPostgres.test.js:111` |
| `npm run build` (TypeScript + Vite production) | PASS — existing bundle-size warning |
| Backend and Hetzner frontend production Docker image builds | PASS |
| Production backend container startup/migrations/health | PASS — `/api/health` 200 |
| Production HTTP OTA denial | PASS — 426 |
| Unauthenticated device over trusted HTTPS proxy path | PASS — 401 |
| Platform Admin login / devices route in production container | PASS — 200 / 200 |
| Chromium UI smoke, desktop and mobile | PASS — register, upload, server SHA visible, START UPDATE confirmation, 37% progress, SUCCESS/history; no page errors |
| `git diff --check`, Node syntax checks | PASS |
| Firmware `pio test -e native` / `pio run -e crowpanel_mock` | NOT RUN — stable project absent |
| Physical OTA / rollback / NVS preservation | NOT RUN — stable project and device unavailable |

The PostgreSQL tests use isolated temporary users/devices/releases and temporary firmware directories. The provisioning test verifies mode 0600, no token in stdout/stderr, individual hashed credentials and refusal to overwrite a provisioning file before rotating. Authentication tests cover no session, tenant admin denial, individual device tokens, other-device download denial, revocation/rotation and stale operations. Firmware tests cover image header/descriptor, file extension, empty/truncated upload, exact 1792 KiB limit, server SHA, immutable releases, hardware compatibility and concurrent assignments. Health/rollback tests cover authenticated reported evidence and persistence; they do not attest a physical board.

The browser and HTTP client use **synthetic non-installable ESP32-S3 fixture bytes** and simulated device reports. Their success is proof of the CICO flow, not of download verification, installation, boot validation or rollback on a CrowPanel. No fixture hash is presented as a deliverable firmware hash.

Docker builds were tested using temporary Dockerfiles identical to the repository versions except for a build-time CA secret mount and `NODE_EXTRA_CA_CERTS` on networked npm/Prisma steps, as required by this managed environment's proxy. TLS verification stayed enabled. The proxy CA is not copied into final image layers. Staging/production on the user's server should use the existing deployment trust/network configuration.

## Reproduce server checks

Use a disposable PostgreSQL database, never production:

```sh
npm ci
DATABASE_URL="$OTA_POSTGRES_TEST_DATABASE_URL" npx prisma generate
DATABASE_URL="$OTA_POSTGRES_TEST_DATABASE_URL" npx prisma validate
DATABASE_URL="$OTA_POSTGRES_TEST_DATABASE_URL" npx prisma migrate deploy
OTA_POSTGRES_TEST_DATABASE_URL="$OTA_POSTGRES_TEST_DATABASE_URL" node --test backend/services/otaProtocol.test.js backend/services/otaPostgres.test.js
npm run build
```

The full suite is `npm test`. To include the existing checkout PostgreSQL test, also set `CHECKOUT_POSTGRES_TEST_DATABASE_URL` to that disposable database. Its existing 404/410 failure is documented above; unrelated checkout code was not changed. There is no separate frontend lint/React test command in the current package scripts; TypeScript production build and browser smoke were used for the new admin page.

## Remaining acceptance work

Supply the full stable `HOOKBOX_Control_V2_CROWPANEL` project at 2.3.0 / 20261002.hmi4. Then integrate the protocol/health/rollback/NVS handling in a separate firmware branch, generate Build A/B and their SHA-256 values, derive the verified final USB command from that project, and run the physical sequence documented in `HOOKBOX_OTA.md`. The OTA vertical remains incomplete until that succeeds.

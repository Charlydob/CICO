# Customer workspace and tenant isolation — 2026-10-27

Customer sessions now expose only explicitly authorized, active hotels. The hotel selector, technical integrations, device administration, firmware/OTA and global diagnostics require the platform administrator role. Customer APIs reject forged hotel contexts, privilege/module changes and cross-hotel resource identifiers. A manager can administer staff and hotel settings but cannot grant or remove owner privileges or change their own permissions. Browser writes require the configured application origin.

The production account audit found one user with `platform_admin` and one manager membership. Its existing access to every hotel is intentional. This account was not downgraded. Customer access must use an invited owner/manager/staff account; no real customer account or password was invented.

## Data and operational corrections

- Tenant-scoped resource lookup uses a database `WHERE tenantId, id`, rather than loading a global record and filtering it afterwards. Composite database foreign keys prevent keys, checkout events and occupancy cycles from referencing another hotel's room.
- Parking evidence requires an authorized hotel-owned detection. Customer DTOs omit server addresses, upstream evidence URLs, raw metadata, firmware/build and device internals. Temporal parking matching cannot associate guests from another hotel or use the default hotel's reservation/plate cache for a different hotel.
- Customer HOOKBOX edits preserve server-owned room/hook mapping. Restore, publish, assets and device detail remain scoped to the hotel. The native design, device synchronization and OTA/rollback protocols are unchanged.
- Expected departures do not register checkout. Expected-departure changes record hotel, actor, time and before/after room dates. A real checkout moves the room to pending cleaning.
- Bed, cleaning and confirmation remain independent. Completion requires both tasks; manager-confirmed correction/undo preserves event history and occupancy cycles. Room locks serialize checkout and corrections. Stale events and a subsequent stay cannot be edited. Repeated completion does not create another effective completion or push. Room status edits/archive cannot bypass pending cleaning.
- Invitation copying no longer rotates the emailed token. New copyable tokens are encrypted with AES-GCM; public DTOs omit hashes/ciphertext. Acceptance is email-bound, password-authenticated for an existing account, and row-locked/transactional. Expired, revoked and already used invitations are rejected.

## Customer interface

Direct contracted-module navigation replaces Operations. Hotel Settings contains General, Staff & Users, HOOKBOX Display, Payments and Integrations. Staff sees operational pages and its own profile. No customer Telegram/Secondary Tools, global hotel selector or technical controls remain. CICO push remains available.

The checkout board separates Pending checkout, Pending cleaning and Ready, with explicit actions and confirmations. Invitations are collapsible, users and roles compact, and the Superadmin hotel list expands one hotel at a time. English is the default CICO language; existing user language preferences and independent guest-facing translations are retained. Profile → Settings → Language changes the CICO preference.

CheckoutBox configuration status no longer shows a green synchronization confirmation without a published configuration. Verification requires matching version, checksum and key count plus a recorded device confirmation time. Missing publication is neutral, and missing confirmation remains pending.

Visual checks cover all available navigation pages plus public login/invitation/QR checkout, expected-departure dialog, room/QR settings, the six display editor tabs, firmware releases, device detail tabs and CheckoutBox RFID/key/trap/console/configuration views. Desktop and mobile overflow, browser exceptions and server failures are checked alongside screenshots. The audit also caught mobile room/QR overflow, empty editor notices, illegible active tabs while hovered and unnecessary mobile editor whitespace.

## External integration boundaries

Stripe Connect uses user/hotel-bound expiring single-use OAuth state, validated account and mode, provider-confirmed disconnect, signed account-bound webhooks, and transactional payment/check-in deduplication. Connected account IDs are retained; OAuth access/refresh tokens are not. Live transport is **not verified**: production has no Connect client ID, platform secret or Connect webhook secret. Configure `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`; register `/api/tenant/payments/stripe/callback` and `/api/stripe/connect/webhook` in the matching Stripe mode.

Production has no invitation email transport configured. The existing email invitation stub now supports an authenticated HTTPS provider webhook through `INVITATION_MAIL_URL` and `INVITATION_MAIL_TOKEN`. It posts `schemaVersion`, `event`, `to`, `subject`, `text`, `inviteUrl`, `expiresAt`; redirects are rejected and delivery acceptance/failure is reported honestly. Configure a real delivery provider before claiming email delivery. Authorized secure invitation links remain available meanwhile. No real emails were sent by these tests.

Steinbock's reservation/PMS authorization API is not available. PMS is shown as Not connected/Coming soon. Optional check-in stage ordering/visibility, including removing verification, remains unavailable in the currently installed display contract. No authorization step was bypassed and no unsupported display control is presented as operational. Individual text alignment/sizing and unsupported screen assets still require a compatible firmware/contract change. Physical HOOKBOX firmware stays at 2.7.0 / 20261026.guest-portal; this release does not flash or actuate the device.

## Validation and safe release

Local verification passed 177 automated tests with no failures or skips, 95 real four-role HTTP assertions, the production build and Prisma validation. Browser checks cover 50 views/states in desktop and mobile (100 screenshots), plus the existing display editor regression suite. These checks include real checkout/cleaning/reversal through the browser. Test tenants, users, sessions and cookie files are temporary; credentials and tokens must not be committed to this repository. Screenshot evidence is kept outside the repository.

Both migrations are additive: tenant/room integrity constraints and a nullable encrypted invitation token column. Historical room ownership was checked before deployment (zero mismatches). Existing invitation hashes/links are retained; an old invitation without ciphertext needs explicit renewal only when its link must be copied.

For the real HTTP/browser audit, `tests/saas-fixture.mjs` creates isolated local fixtures and a private session file outside the repository. It refuses every database except `127.0.0.1:55439/hookbox_test_final`. Start the backend on 3001 and Vite on 4321 with the same test `SESSION_SECRET`; set `APP_ORIGIN=http://127.0.0.1:4321`, `OTA_DEV_ALLOW_HTTP=true`, `FRIGATE_POLL_ENABLED=false`, and `DATA_DIR`/`EVIDENCE_DIR` to the sibling `saas-local-data`/`saas-evidence` directories. Run `tests/saas-live-api.mjs`, `tests/saas-live-ui.mjs` and `tests/saas-live-extra-ui.mjs`; then `tests/saas-fixture-cleanup.mjs` removes only the recorded local fixtures and private sessions. `SAAS_SCREENSHOTS` selects the evidence directory. These checks do not contact a real panel, deliver keys or send email.

The main deployment pipeline validates PostgreSQL migrations/tests/build/schema, saves the previous commit, database dump and data/evidence volumes under `/opt/hotelapp/backups/<UTC>-<release SHA>`, then verifies backend/frontend release identities and health.

Rollback application code to the previous known-good commit `436fc7c15c1af58617bdaeeca989138f6df5ff62`, using the existing deployment configuration and the same `hotelapp` Compose project/volumes. Keep both additive database migrations in place; the previous application can ignore the new column. Do not restore an old database snapshot during an ordinary application rollback: that would discard newer hotel operations. Restore the saved database/data/evidence only as a coordinated disaster recovery operation. Confirm `/api/health`, `/api/version` and `/version.json` after rollback.

# PIN delivery and HTTP integration — 28 October 2026

## Starting points and preservation

- CICO deployment/main: `e39bdcce95a24484779411a4b817a350b9e0ccdd`.
- CICO implementation starts from PR #32 head `0e826bfc314bfa767879ccd09132d929b777e9fd`, reusing its device integration entry points. Its inbound hotel authorization is retired with HTTP 410.
- HOOKBOX-FIRMWARE main: `de17875`; local older checkout `4e88e72e8b45eea28c48e89b376b64f19e3fbd4c` and its uncommitted edits were preserved.
- CHECKOUTBOX-FIRMWARE: `01ee964fad9f2573d0303f3fe7ddd2fe1e014a95`. This separate existing firmware needs the accepted-return event; RFID_READ alone is insufficient.
- All work uses `codex/` branches and separate checkouts. Original local changes were not overwritten.

## Configure a hook

1. Open Hotel → Devices → the HOOKBOX device. In global administration use the device's operation tab.
2. Choose physical hook 1–25, enter its room and a numeric PIN, and leave Active checked.
3. Save. The PIN is never displayed again. A blank PIN when editing preserves the existing one.
4. Select the allowed PIN lengths (4–12 digits) if needed.
5. After replacing the key, use Rehabilitar entrega and enter the reason. An active operation must expire or finish before rearming.
6. Expand channel identification to see board/address/channel. It never energizes an output.

Rooms (case insensitive) and PINs must be unique within each device. PINs use salted Argon2id hashes. Five failed attempts cause a persistent 15-minute lock. Credentials, device ownership and tenant scope are checked server-side. A successful PIN reserves the hook atomically; repeat entry cannot reserve it again. Reservations survive backend/device restart. Uncertain power-loss outcomes require staff reconciliation.

`DELIVERED` means confirmed electrical activation, with `physicallyConfirmed=false`. It is not proof of physical key removal. Mock results never create real outgoing events.

## Display

Firmware 2.8.0 uses the existing touch screen and hidden administration/Wi-Fi access. Its public view has only the masked PIN, numeric keypad, confirmation and optional displayed QR, plus configured image branding. No reservation lookup, surname search, external authorization or room picker remains in the public flow.

The existing screen editor now previews this flow at 800 × 480. QR content, size, position and quiet margin, text, colors, logo and background remain editable. Hiding the QR centers the keypad; moving it left moves the keypad right. The backend and firmware validate bounds and overlap. Publish visual changes through existing design sync/ACK, without OTA. Hotel designs and device overrides remain separate. The first change from the previous guest flow requires firmware OTA.

## Hotel HTTP configuration

Open Administration → Devices → the device → Integración HTTP. HOOKBOX and Checkout Box have independent settings.

Defaults are disabled and unconfirmed, POST, Europe/Zurich, with editable `key` and `check-in at` / `check-out at`. Provisional HTTPS destinations are prefilled. Header values/authentication remain in backend-only tables, including event credential snapshots; APIs return only header names and masked indicators.

Choose each JSON value's source from room, recorded event date/time, device identifier, operation identifier or a fixed value. Simular JSON never contacts a destination or activates hardware. Saving requires no environment-variable edits.

Before enabling actual sends, confirm with Urs:

- exact check-in/check-out URLs and permitted methods;
- field names/types and date/time contract;
- authentication/header values and authorization to send;
- response semantics: what confirms business processing;
- supported idempotency mechanism (CICO sends the stable Idempotency-Key header).

A successful 2xx is recorded as `HTTP_ACCEPTED`, never as confirmed hotel processing. `processedAt` remains empty until a future agreed acknowledgement contract is implemented. Redirects are not followed. All resolved DNS addresses must be public; the checked IP is pinned for the request, preventing DNS rebinding. TLS verification remains enabled.

## Reliability and checkout

Electrical result recording, hook state and the check-in outbox row commit in one transaction. Failed hotel POSTs never call the actuator. The persistent worker uses leases, eight bounded attempts and exponential delays; transient failures retry, permanent failures remain visible. Events created while disabled remain HELD. Administrative resend preserves the event identity and original recorded time. Exactly-once hotel processing requires hotel-side idempotency; an interrupted acknowledgement may cause another HTTP delivery.

Checkout Box 1.3.1 adds a persistent accepted-return journal while retaining RFID, servo, configuration and OTA behavior. New RFID observations are tagged `return_flow_v2`; housekeeping and hotel notification follow the accepted servo-cycle command. Accepted records survive reboot/network loss and are removed only after CICO accepts them. An intention interrupted by power loss is not automatically replayed or announced as success. Sixteen pending journal entries are allowed; lack of durable storage blocks another automatic return rather than losing its accepted event. Servo command acceptance still does not provide physical position/key-drop sensing.

CICO deduplicates durable return IDs transactionally, resolves the current authorized RFID-to-room mapping and preserves existing housekeeping/notification services. Legacy 1.3.0 RFID housekeeping continues; it cannot create a hotel POST from a simple read. Checkout Box 1.3.1 must be installed on that separate device to enable accepted-return notifications.

## Validation

See the delivery report for actual build/deployment/device versions. Local verification includes PostgreSQL migrations, PIN success/failure/lockout/replay/isolation, concurrent reservations, administrative rearm, outage/reboot uncertainty, HTTP retry/restart/deduplication and redaction, RFID checkout/housekeeping, QR enabled/disabled/left and persisted settings, and real HTTP with the compiled C++ simulator across all 25 hooks. Native firmware safety and OTA regression suites are retained. All automated actuator operations use mock drivers. No real hotel request is part of validation.

## Deployment / rollback

Migrations add dedicated PIN, guard, HTTP config, outbox and durable return receipt tables. No existing tables/data are removed. Disable integrations before any rollback; HELD/PENDING events remain stored. Restore the previous application images/commit for application rollback, leaving the additive tables in place. Database restore is a separate deliberate recovery step because restoring a snapshot discards later business events.

A full private 4 MiB CrowPanel flash backup was saved outside Git before any update, including its original partition table, NVS and both application slots. It contains credentials and must remain private. The original running slot was `ota_1`, version 2.7.0 (`20261026.guest-portal`); `ota_0` contained 2.6.3 (`20261026.ota-mmap-wake-fix`). Partition offsets/credentials are unchanged by normal OTA.

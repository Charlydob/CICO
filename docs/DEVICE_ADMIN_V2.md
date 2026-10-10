# Device administration V2

This change is server-only and remains compatible with CheckoutBox firmware 1.3.0 and the existing CrowPanel Hookbox protocol. It does not add device endpoints, command types or configuration fields that require a firmware update.

## RFID and key returns

Every authenticated `RFID_READ` event is stored as a chronological `DeviceRfidReading` with snapshots of the key name, room, hotel and device context. Reassigning a device does not rewrite old records.

CICO uses three deliberately different meanings:

- **RFID read:** the device reported a UID.
- **Return recorded from a read:** the UID was active and authorized, the device was assigned to a hotel, and the configured room matched an active room in that hotel.
- **Physically confirmed return:** not available with the current hardware/firmware and never claimed by CICO.

Repeated reads inside the configured RFID duplicate window (at least 1.5 seconds and at most 10 seconds) remain visible as suppressed reads but do not create another return or notification. A valid return creates a `CheckoutEvent` with source `rfid_return`, status `recorded_unconfirmed` and `physicalConfirmation: false`. The room is not moved automatically into cleaning because the existing sensor cannot prove that the key fell into the basket.

Web Push reuses the tenant-scoped checkout preference and recipient logic. Only enabled housekeeping users of the associated hotel receive “Nueva devolución registrada”. Unknown, rejected, unlinked and duplicate reads do not generate a successful-return notification.

## Device assignment and retention

Platform administrators can assign, unassign or reassign both CheckoutBox and Hookbox devices. Each change creates a `DeviceTenantAssignment` audit snapshot. Device credentials are untouched.

RFID readings, OTA requests and commands are paginated and retained as audit data. The rolling technical console keeps the existing limit of 1,000 recent low-level `DeviceEvent` records per device.

## Servo preview

Firmware 1.3.0 supports only discrete `TEST_SERVO_POSITION` commands and polls CICO periodically. The UI therefore sends a preview only after an explicit button press. When a preview is still pending, another preview supersedes it so movements cannot accumulate. The UI waits for the normal command acknowledgement and explicitly states that the SG90 provides no physical position feedback.

No movement commands are emitted by builds, tests, migrations or deployment.

## OTA reconciliation

Installed firmware/build values shown in the UI always come from the latest heartbeat and are separate from the immutable OTA request history. Administrative cancellation remains `CANCELLED` even if the device later reports the target version.

If an active request is in `REBOOTING` or `HEALTH_CHECK`, the installed version matches the release, but the reported build differs, CICO terminates the request as `FAILED / INSTALLED_BUILD_MISMATCH`. This prevents a new indefinite rebooting state without converting the request to a false success. The actual installed version and build remain visible for diagnosis.

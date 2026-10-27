# HOOKBOX guest portal

The hotel administrator opens `/t/<hotel-slug>/devices`, selects the assigned CrowPanel and uses **Personalizar pantalla**. The per-device editor is `/t/<hotel-slug>/devices/<device-uuid>/screen`; it reuses the existing drafts, immutable publications, assets and device acknowledgments. The general hotel editor remains `/t/<hotel-slug>/hookbox`.

Firmware 2.7.0 (`20261026.guest-portal`) renders the shared 800 × 480 geometry on the validated Elecrow CrowPanel. Seven inches does not establish a different pixel resolution. No panel timing or partition changes were made. Public legacy views are excluded from the check-in build; maintenance uses the existing PIN after a five-second hold on the hotel name.

Editable properties include hotel identity, logo, decoration, all four translations, default language, QR content/size/visibility, background/card/button/input/text colors and public session timing. The 60-second physical backlight policy remains independent of visual session timing.

## Design byte integrity

`manifest` is JSONB for editor history and queries. PostgreSQL may reorder its object keys; serializing that value after retrieval cannot reconstruct the original publication bytes. `manifestRaw` stores the exact UTF-8 JSON string hashed during publication. Device sync checks and returns that string unchanged, with the original SHA-256. The migration adds a nullable TEXT column without rewriting published history. Legacy rows without exact bytes are served only if their reconstructed bytes already match their stored hash; otherwise only hotel identity is returned, with no design, until a new publication is made. This still lets a reassigned device clear its previous hotel while retaining the same hotel’s last valid offline design. Integrity checks remain enabled.

## Verification

Local verification covers 160 backend tests with PostgreSQL and the native check-in simulator, editor interactions and the tenant-admin device-detail-editor path in Playwright. The firmware has 69 passing native cases, OTA scanner regression checks and a successful real CrowPanel build. Physical OTA and design acceptance must be evidenced by device status and ACK; browser previews do not establish physical appearance, touch behavior, QR scanning or electrical delivery.

## UX delivery scope (2026-10-27)

Implemented: distinct Operations navigation, hotel header without Support Mode, global Devices/Firmware inside Admin; Preview/Edit modes, selection highlight and contextual editing of supported text and shared colors; compact categories, one translation field selector, mobile contextual sheet. All editable values use the existing persisted theme and immutable publication protocol. CICO language infrastructure is unchanged. Hardware firmware remains 2.7.0 and 800x480.

Pending: optional check-in stages and secure authorization without a user-entered challenge; a documented real hotel provider is required. Existing lookup deliberately does not authorize key release. No timer-based preview result is used on the physical device. Also pending: drag/position/alignment/individual font sizes and room number typography; these require a versioned firmware/rendering contract and matching physical OTA tests. No preview-only geometry controls or fake stage switches have been added. A 1024x600 panel has not been identified or validated.

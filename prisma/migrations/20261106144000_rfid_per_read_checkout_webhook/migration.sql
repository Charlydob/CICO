-- Each physical RFID_READ event can enqueue its own hotel webhook without
-- requiring a local checkout event or an occupancy cycle.
ALTER TABLE "checkout_webhook_deliveries"
  ALTER COLUMN "checkout_event_id" DROP NOT NULL;

ALTER TABLE "checkout_webhook_deliveries"
  ADD COLUMN "rfid_reading_id" UUID;

CREATE UNIQUE INDEX "checkout_webhook_deliveries_rfid_reading_id_key"
  ON "checkout_webhook_deliveries"("rfid_reading_id");

ALTER TABLE "checkout_webhook_deliveries"
  ADD CONSTRAINT "checkout_webhook_deliveries_rfid_reading_id_fkey"
  FOREIGN KEY ("rfid_reading_id") REFERENCES "device_rfid_readings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkout_webhook_deliveries"
  ADD CONSTRAINT "checkout_webhook_deliveries_source_check"
  CHECK (
    ("checkout_event_id" IS NOT NULL AND "rfid_reading_id" IS NULL)
    OR
    ("checkout_event_id" IS NULL AND "rfid_reading_id" IS NOT NULL)
  );

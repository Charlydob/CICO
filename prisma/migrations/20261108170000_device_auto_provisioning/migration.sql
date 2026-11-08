ALTER TABLE "devices" ADD COLUMN "hardware_uid" TEXT;

CREATE UNIQUE INDEX "devices_hardware_uid_key" ON "devices"("hardware_uid");

CREATE TABLE "device_discoveries" (
  "id" UUID NOT NULL,
  "device_id" TEXT NOT NULL,
  "hardware_model" TEXT NOT NULL,
  "hardware_uid" TEXT NOT NULL,
  "firmware_version" TEXT NOT NULL,
  "build_id" TEXT NOT NULL,
  "pairing_code_hash" TEXT NOT NULL,
  "bootstrap_token_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "approved_device_id" UUID,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_at" TIMESTAMP(3),
  "credential_delivered_at" TIMESTAMP(3),
  "approved_by" TEXT,
  CONSTRAINT "device_discoveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_discoveries_device_id_key" ON "device_discoveries"("device_id");
CREATE UNIQUE INDEX "device_discoveries_hardware_uid_key" ON "device_discoveries"("hardware_uid");
CREATE UNIQUE INDEX "device_discoveries_approved_device_id_key" ON "device_discoveries"("approved_device_id");
CREATE INDEX "device_discoveries_status_last_seen_at_idx" ON "device_discoveries"("status", "last_seen_at");

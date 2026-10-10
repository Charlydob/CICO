ALTER TABLE "devices"
  ADD COLUMN "applied_config" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "config_checksum" TEXT,
  ADD COLUMN "authorized_rfid_count" INTEGER,
  ADD COLUMN "config_applied_at" TIMESTAMP(3),
  ADD COLUMN "config_rejected_reason" TEXT;

CREATE TABLE "device_rfid_keys" (
  "id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "uid" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "room" TEXT NOT NULL DEFAULT '',
  "authorized" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "first_seen_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "device_rfid_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_rfid_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "device_rfid_keys_device_id_uid_key" ON "device_rfid_keys"("device_id", "uid");
CREATE INDEX "device_rfid_keys_device_id_last_seen_at_idx" ON "device_rfid_keys"("device_id", "last_seen_at");
CREATE INDEX "device_rfid_keys_device_id_authorized_active_idx" ON "device_rfid_keys"("device_id", "authorized", "active");

-- Preserve every UID already stored in the legacy desired configuration.
INSERT INTO "device_rfid_keys" ("id", "device_id", "uid", "authorized", "active", "updated_at")
SELECT gen_random_uuid(), d."id", upper(uid.value), true, true, CURRENT_TIMESTAMP
FROM "devices" d
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(d."desired_config"->'allowedRfids', '[]'::jsonb)) AS uid(value)
WHERE uid.value ~* '^(?:[0-9a-f]{8}|[0-9a-f]{10})$'
ON CONFLICT ("device_id", "uid") DO NOTHING;

INSERT INTO "device_rfid_keys" ("id", "device_id", "uid", "authorized", "active", "first_seen_at", "last_seen_at", "updated_at")
SELECT gen_random_uuid(), d."id", upper(d."last_rfid"), false, true, d."last_seen_at", d."last_seen_at", CURRENT_TIMESTAMP
FROM "devices" d
WHERE d."last_rfid" ~* '^(?:[0-9a-f]{8}|[0-9a-f]{10})$'
ON CONFLICT ("device_id", "uid") DO UPDATE SET
  "last_seen_at" = EXCLUDED."last_seen_at",
  "first_seen_at" = COALESCE("device_rfid_keys"."first_seen_at", EXCLUDED."first_seen_at");

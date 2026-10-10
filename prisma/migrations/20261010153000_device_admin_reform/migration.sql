CREATE TABLE "device_rfid_readings" (
  "id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "tenant_id" UUID,
  "key_id" UUID,
  "checkout_event_id" UUID,
  "uid" TEXT NOT NULL,
  "key_name" TEXT NOT NULL DEFAULT '',
  "room" TEXT NOT NULL DEFAULT '',
  "hotel_name" TEXT NOT NULL DEFAULT '',
  "authorized" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "duplicate" BOOLEAN NOT NULL DEFAULT false,
  "event_type" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "diagnostic" TEXT,
  "device_uptime_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_rfid_readings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_rfid_readings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "device_rfid_readings_device_id_created_at_idx" ON "device_rfid_readings"("device_id", "created_at");
CREATE INDEX "device_rfid_readings_tenant_id_created_at_idx" ON "device_rfid_readings"("tenant_id", "created_at");
CREATE INDEX "device_rfid_readings_uid_created_at_idx" ON "device_rfid_readings"("uid", "created_at");
CREATE INDEX "device_rfid_readings_event_type_result_created_at_idx" ON "device_rfid_readings"("event_type", "result", "created_at");

CREATE TABLE "device_tenant_assignments" (
  "id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "from_tenant_id" UUID,
  "from_tenant_name" TEXT NOT NULL DEFAULT '',
  "to_tenant_id" UUID,
  "to_tenant_name" TEXT NOT NULL DEFAULT '',
  "assigned_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_tenant_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_tenant_assignments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "device_tenant_assignments_device_id_created_at_idx" ON "device_tenant_assignments"("device_id", "created_at");
CREATE INDEX "device_tenant_assignments_to_tenant_id_created_at_idx" ON "device_tenant_assignments"("to_tenant_id", "created_at");

BEGIN;
ALTER TABLE "devices" ADD COLUMN "desired_config" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "devices" ADD COLUMN "last_rfid" TEXT;
ALTER TABLE "devices" ADD COLUMN "last_rfid_raw" TEXT;
ALTER TABLE "devices" ADD COLUMN "trap_state" TEXT;
ALTER TABLE "device_commands" ADD COLUMN "payload" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "device_commands" ADD COLUMN "result" JSONB;
ALTER TABLE "device_commands" DROP CONSTRAINT "device_commands_type";
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_type" CHECK ("type" IN ('OPEN_TRAP','CLOSE_TRAP','CYCLE_TRAP','SET_SERVO_CONFIG','CHECK_RFID','RESTART','CHECK_UPDATE'));
CREATE TABLE "device_events" (
  "id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "detail" TEXT,
  "uptime_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "device_events_device_id_created_at_idx" ON "device_events"("device_id", "created_at");
COMMIT;

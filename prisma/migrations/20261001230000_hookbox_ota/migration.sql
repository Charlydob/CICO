-- Additive migration: existing hotel tables/rows are unchanged.
BEGIN;

-- CreateEnum
CREATE TYPE "OtaStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'VERIFYING', 'INSTALLING', 'REBOOTING', 'HEALTH_CHECK', 'SUCCESS', 'FAILED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "hardware_model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "current_firmware_version" TEXT,
    "current_build_id" TEXT,
    "target_firmware_version" TEXT,
    "config_version" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "last_ip" TEXT,
    "last_rssi" INTEGER,
    "uptime" INTEGER,
    "free_heap" INTEGER,
    "psram" INTEGER,
    "last_reset_reason" TEXT,
    "last_ota_status" "OtaStatus",
    "last_ota_result" TEXT,
    "token_hash" TEXT,
    "credential_version" INTEGER NOT NULL DEFAULT 0,
    "credential_rotated_at" TIMESTAMP(3),
    "credential_revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firmware_releases" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "build_id" TEXT NOT NULL,
    "hardware_model" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "release_notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "signature" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firmware_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ota_requests" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "status" "OtaStatus" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "previous_version" TEXT,
    "previous_build_id" TEXT,
    "result_code" TEXT,
    "requested_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ota_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ota_events" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "status" "OtaStatus" NOT NULL,
    "progress" INTEGER NOT NULL,
    "result_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ota_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_device_id_key" ON "devices"("device_id");

-- CreateIndex
CREATE INDEX "devices_tenant_id_idx" ON "devices"("tenant_id");

-- CreateIndex
CREATE INDEX "devices_last_seen_at_idx" ON "devices"("last_seen_at");

-- CreateIndex
CREATE INDEX "devices_hardware_model_idx" ON "devices"("hardware_model");

-- CreateIndex
CREATE UNIQUE INDEX "firmware_releases_storage_path_key" ON "firmware_releases"("storage_path");

-- CreateIndex
CREATE INDEX "firmware_releases_hardware_model_status_idx" ON "firmware_releases"("hardware_model", "status");

-- CreateIndex
CREATE UNIQUE INDEX "firmware_releases_hardware_model_version_build_id_key" ON "firmware_releases"("hardware_model", "version", "build_id");

-- CreateIndex
CREATE INDEX "ota_requests_device_id_created_at_idx" ON "ota_requests"("device_id", "created_at");

-- CreateIndex
CREATE INDEX "ota_requests_release_id_idx" ON "ota_requests"("release_id");

-- CreateIndex
CREATE INDEX "ota_requests_status_updated_at_idx" ON "ota_requests"("status", "updated_at");

-- CreateIndex
CREATE INDEX "ota_events_request_id_created_at_idx" ON "ota_events"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "device_commands_device_id_status_idx" ON "device_commands"("device_id", "status");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firmware_releases" ADD CONSTRAINT "firmware_releases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_requests" ADD CONSTRAINT "ota_requests_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_requests" ADD CONSTRAINT "ota_requests_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "firmware_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_requests" ADD CONSTRAINT "ota_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_events" ADD CONSTRAINT "ota_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ota_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Defense in depth for overlapping requests even if another writer bypasses the service.
CREATE UNIQUE INDEX "ota_requests_one_active_per_device" ON "ota_requests"("device_id")
WHERE "status" IN ('PENDING', 'DOWNLOADING', 'VERIFYING', 'INSTALLING', 'REBOOTING', 'HEALTH_CHECK');
ALTER TABLE "ota_requests" ADD CONSTRAINT "ota_requests_progress_range" CHECK ("progress" BETWEEN 0 AND 100);
ALTER TABLE "ota_events" ADD CONSTRAINT "ota_events_progress_range" CHECK ("progress" BETWEEN 0 AND 100);
ALTER TABLE "firmware_releases" ADD CONSTRAINT "firmware_releases_positive_size" CHECK ("file_size" > 0);
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_type" CHECK ("type" IN ('CHECK_UPDATE', 'RESTART'));

COMMIT;

CREATE TABLE "device_return_receipts" (
 "id" TEXT PRIMARY KEY, "device_id" UUID NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
 "tenant_id" UUID NOT NULL, "checkout_event_id" UUID, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "device_return_receipts_tenant_id_device_id_idx" ON "device_return_receipts"("tenant_id","device_id");

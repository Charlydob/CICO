CREATE TABLE "checkout_webhook_deliveries" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "checkout_event_id" UUID NOT NULL,
  "endpoint_url" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "auth_header_name" TEXT,
  "auth_header_value" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_http_status" INTEGER,
  "last_error" TEXT,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "checkout_webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checkout_webhook_deliveries_checkout_event_id_key" ON "checkout_webhook_deliveries"("checkout_event_id");
CREATE INDEX "checkout_webhook_deliveries_status_next_attempt_at_idx" ON "checkout_webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "checkout_webhook_deliveries_tenant_id_created_at_idx" ON "checkout_webhook_deliveries"("tenant_id", "created_at");
ALTER TABLE "checkout_webhook_deliveries" ADD CONSTRAINT "checkout_webhook_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_webhook_deliveries" ADD CONSTRAINT "checkout_webhook_deliveries_checkout_event_id_fkey" FOREIGN KEY ("checkout_event_id") REFERENCES "checkout_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

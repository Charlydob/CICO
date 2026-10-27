-- CreateTable
CREATE TABLE "device_pin_hooks" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "hook" INTEGER NOT NULL,
    "room" TEXT NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "operation_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_pin_hooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_pin_guards" (
    "device_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "window_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),
    "min_length" INTEGER NOT NULL DEFAULT 4,
    "max_length" INTEGER NOT NULL DEFAULT 12,

    CONSTRAINT "device_pin_guards_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "device_http_integrations" (
    "device_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "secrets" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_http_integrations_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "device_outbound_events" (
    "id" TEXT NOT NULL,
    "device_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "context" JSONB NOT NULL,
    "config" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'HELD',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "http_status" INTEGER,
    "http_accepted_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_outbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_pin_hooks_tenant_id_device_id_idx" ON "device_pin_hooks"("tenant_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_pin_hooks_device_id_hook_key" ON "device_pin_hooks"("device_id", "hook");

-- CreateIndex
CREATE UNIQUE INDEX "device_pin_hooks_device_id_room_key" ON "device_pin_hooks"("device_id", "room");

-- CreateIndex
CREATE INDEX "device_http_integrations_tenant_id_idx" ON "device_http_integrations"("tenant_id");

-- CreateIndex
CREATE INDEX "device_outbound_events_state_next_attempt_at_idx" ON "device_outbound_events"("state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "device_outbound_events_tenant_id_device_id_created_at_idx" ON "device_outbound_events"("tenant_id", "device_id", "created_at");

-- AddForeignKey
ALTER TABLE "device_pin_hooks" ADD CONSTRAINT "device_pin_hooks_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_pin_guards" ADD CONSTRAINT "device_pin_guards_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_http_integrations" ADD CONSTRAINT "device_http_integrations_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_outbound_events" ADD CONSTRAINT "device_outbound_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

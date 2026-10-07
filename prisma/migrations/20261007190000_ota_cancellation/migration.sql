ALTER TYPE "OtaStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "ota_requests"
  ADD COLUMN "cancelled_by" UUID,
  ADD COLUMN "cancelled_at" TIMESTAMP(3);

CREATE INDEX "ota_requests_cancelled_by_idx" ON "ota_requests"("cancelled_by");

ALTER TABLE "ota_requests"
  ADD CONSTRAINT "ota_requests_cancelled_by_fkey"
  FOREIGN KEY ("cancelled_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

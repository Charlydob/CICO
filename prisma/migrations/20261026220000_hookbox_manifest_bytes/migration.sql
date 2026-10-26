-- Preserve the exact UTF-8 bytes whose SHA-256 is published. JSONB is for editor queries only.
ALTER TABLE "hookbox_designs" ADD COLUMN "manifest_raw" TEXT;

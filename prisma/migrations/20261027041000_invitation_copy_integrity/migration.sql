-- Preserve emailed invitation links when an authorized manager copies them. Existing token hashes remain valid.
ALTER TABLE "invitations" ADD COLUMN "encrypted_token" TEXT;

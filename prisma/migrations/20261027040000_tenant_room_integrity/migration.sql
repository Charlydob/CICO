-- Add constraints without rewriting customer rows; abort if historical ownership is inconsistent.
CREATE UNIQUE INDEX "rooms_tenant_id_id_key" ON "rooms"("tenant_id","id");
ALTER TABLE "key_identifiers" ADD CONSTRAINT "keys_room_hotel_fk" FOREIGN KEY ("tenant_id","room_id") REFERENCES "rooms"("tenant_id","id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "checkout_events" ADD CONSTRAINT "checkout_room_hotel_fk" FOREIGN KEY ("tenant_id","room_id") REFERENCES "rooms"("tenant_id","id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "occupancy_cycles" ADD CONSTRAINT "cycle_room_hotel_fk" FOREIGN KEY ("tenant_id","room_id") REFERENCES "rooms"("tenant_id","id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "key_identifiers" VALIDATE CONSTRAINT "keys_room_hotel_fk";
ALTER TABLE "checkout_events" VALIDATE CONSTRAINT "checkout_room_hotel_fk";
ALTER TABLE "occupancy_cycles" VALIDATE CONSTRAINT "cycle_room_hotel_fk";

CREATE TABLE hookbox_hotels (tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE, draft jsonb NOT NULL, revision integer NOT NULL DEFAULT 0, published_version text, mapping jsonb NOT NULL DEFAULT '[]', updated_at timestamp(3) NOT NULL);
CREATE TABLE hookbox_designs (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE, manifest jsonb NOT NULL, sha256 text NOT NULL, created_at timestamp(3) NOT NULL DEFAULT now(), created_by text NOT NULL);
CREATE INDEX hookbox_designs_tenant_id_created_at_idx ON hookbox_designs(tenant_id,created_at);
CREATE TABLE hookbox_assets (id text NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE, kind text NOT NULL, width integer NOT NULL, height integer NOT NULL, bytes bytea NOT NULL, PRIMARY KEY(tenant_id,id));
CREATE TABLE hookbox_operations (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE, device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT ON UPDATE CASCADE, state jsonb NOT NULL, expires_at timestamp(3) NOT NULL, created_at timestamp(3) NOT NULL DEFAULT now());
CREATE INDEX hookbox_operations_tenant_id_device_id_idx ON hookbox_operations(tenant_id,device_id);
CREATE TABLE hookbox_claims (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE CASCADE, reservation_id text NOT NULL, room text NOT NULL, operation_id uuid NOT NULL REFERENCES hookbox_operations(id) ON DELETE RESTRICT ON UPDATE CASCADE, UNIQUE(tenant_id,reservation_id,room));
ALTER TABLE devices ADD COLUMN ui_desired_version text, ADD COLUMN ui_applied_version text, ADD COLUMN ui_checksum text, ADD COLUMN ui_rejected_reason text;



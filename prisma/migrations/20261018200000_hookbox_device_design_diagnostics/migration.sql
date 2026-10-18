ALTER TABLE hookbox_designs ADD COLUMN device_id uuid;
CREATE TABLE hookbox_device_designs(device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE ON UPDATE CASCADE,tenant_id uuid NOT NULL,draft jsonb NOT NULL,mapping jsonb NOT NULL DEFAULT '[]',revision integer NOT NULL DEFAULT 0,published_version text,updated_at timestamp(3) NOT NULL);
CREATE INDEX hookbox_device_designs_tenant_id_idx ON hookbox_device_designs(tenant_id);
CREATE TABLE hookbox_protocol_traces(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE ON UPDATE CASCADE,path text NOT NULL,status integer NOT NULL,request jsonb NOT NULL,response jsonb NOT NULL,created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX hookbox_protocol_traces_tenant_id_device_id_created_at_idx ON hookbox_protocol_traces(tenant_id,device_id,created_at);

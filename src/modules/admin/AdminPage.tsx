import { ExternalLink, FlaskConical, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { UserManagementPanel } from "../../components/UserManagementPanel";
import {
  createTenant,
  createAdminTenantInvitation,
  deleteAdminTenant,
  getAdminTenantInvitationLink,
  getAdminTenants,
  regenerateAdminTenantInvitation,
  revokeAdminTenantInvitation,
  revokeAdminTenantMembership,
  setAdminTenantModule,
  updateAdminTenant,
  updateAdminTenantMembershipAlias,
  updateAdminTenantMembershipRole,
  type AdminTenantSummary,
} from "../../services/backendApi";
import { MODULE_REGISTRY, type ModuleId } from "../../types/modules";

export function AdminPage() {
  const [tenants, setTenants] = useState<AdminTenantSummary[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [notice, setNotice] = useState("");

  async function reload() {
    setTenants(await getAdminTenants());
  }

  useEffect(() => {
    void reload().catch((error) =>
      setNotice(error instanceof Error ? error.message : "Could not load tenants."),
    );
  }, []);

  async function addTenant() {
    await createTenant({
      name,
      slug,
      modules: {
        parking: true,
        checkout: true,
      },
    });
    setName("");
    setSlug("");
    setNotice("Tenant created.");
    await reload();
  }

  async function addDemoTenant() {
    try {
      await createTenant({
        name: "Demo Hotel",
        slug: "demo-hotel",
        modules: {
          parking: true,
          checkout: true,
        },
      });
      setNotice("Demo tenant created.");
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Demo tenant already exists.");
      await reload();
    }
  }

  async function toggleModule(tenant: AdminTenantSummary, moduleId: ModuleId) {
    await setAdminTenantModule(tenant.id, moduleId, !tenant.modules[moduleId]);
    await reload();
  }

  async function removeTenant(tenant: AdminTenantSummary) {
    if (!window.confirm(`Delete ${tenant.name}? This cannot be undone.`)) {
      return;
    }

    try {
      await deleteAdminTenant(tenant.id);
      setNotice("Tenant deleted.");
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete tenant.");
    }
  }

  function openHotel(tenant: AdminTenantSummary) {
    window.open(`/t/${encodeURIComponent(tenant.slug)}/dashboard`, "_blank", "noopener,noreferrer");
  }

  function openHotelIntegrations(tenant: AdminTenantSummary) {
    window.open(
      `/t/${encodeURIComponent(tenant.slug)}/admin/integrations`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  return (
    <section className="module-page platform-admin-page">
      <div className="module-title">
        <div>
          <h1>Superadmin</h1>
          <p>Tenants, users and enabled modules.</p>
        </div>
        <button type="button" onClick={() => void reload()}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      {notice && (
        <div className={notice.includes("Could not") ? "notice error" : "notice"}>
          {notice}
        </div>
      )}

      <section className="panel">
        <div className="section-heading">
          <h2>Create tenant</h2>
        </div>
        <div className="settings-form">
          <div className="settings-split">
            <label>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>Slug</span>
              <input value={slug} onChange={(event) => setSlug(event.target.value)} />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={addTenant} disabled={!name.trim()}>
              <Plus size={15} />
              Create tenant
            </button>
            <button type="button" onClick={addDemoTenant}>
              <FlaskConical size={15} />
              Add demo tenant
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Tenants</h2>
          <span>{tenants.length}</span>
        </div>
        <div className="tenant-table">
          {tenants.map((tenant) => (
            <details key={tenant.id} className="hotel-admin-row">
            <summary><strong>{tenant.name}</strong><span>{tenant.active?"Active":"Inactive"}</span><span>{MODULE_REGISTRY.filter(module=>module.implemented&&tenant.modules[module.id]).map(module=>module.label).join(" · ")||"No modules"}</span><span>Manage hotel</span></summary>
            <article className="tenant-row">
              <div>
                <strong>{tenant.name}</strong>
                <span>{tenant.slug}</span>
                <div className="button-row compact-actions">
                  <button type="button" onClick={() => openHotel(tenant)}>
                    <ExternalLink size={15} />
                    Open hotel
                  </button>
                  <button type="button" onClick={() => openHotelIntegrations(tenant)}>
                    <ExternalLink size={15} />
                    Integrations
                  </button>
                  <button type="button" onClick={() => void removeTenant(tenant)}>
                    <Trash2 size={15} />
                    Delete
                  </button>
                </div>
              </div>
              <TenantSummary tenant={tenant} onReload={reload} onNotice={setNotice} />
              <TenantUsers tenant={tenant} onReload={reload} onNotice={setNotice} />
              <span>{new Date(tenant.createdAt).toLocaleDateString()}</span>
              <div className="module-toggle-list">
                {MODULE_REGISTRY.map((module) => (
                  <button
                    key={module.id}
                    type="button"
                    className={tenant.modules[module.id] ? "active" : ""}
                    onClick={() => toggleModule(tenant, module.id)}
                  >
                    {module.label} {tenant.modules[module.id] ? "ON" : "OFF"}
                  </button>
                ))}
              </div>
            </article></details>
          ))}
        </div>
      </section>
    </section>
  );
}

function TenantSummary({
  tenant,
  onReload,
  onNotice,
}: {
  tenant: AdminTenantSummary;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [name, setName] = useState(tenant.name);
  const [slug, setSlug] = useState(tenant.slug);
  const [active, setActive] = useState(tenant.active);
  const [displayName, setDisplayName] = useState(
    tenant.basicInfo?.displayName || tenant.name,
  );

  async function saveTenant() {
    await updateAdminTenant(tenant.id, {
      name,
      slug,
      active,
      basicInfo: {
        ...(tenant.basicInfo || {}),
        displayName,
      },
    });
    onNotice("Tenant updated.");
    await onReload();
  }

  return (
    <div className="tenant-summary">
      <strong>{tenant.active ? "Active" : "Inactive"}</strong>
      <label>
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>Slug</span>
        <input value={slug} onChange={(event) => setSlug(event.target.value)} />
      </label>
      <label>
        <span>Visible name</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
        />
        <span>Active</span>
      </label>
      <button type="button" onClick={() => void saveTenant()}>
        <Save size={15} />
        Save
      </button>
      <span>Reservations: {tenant.settingsSummary.reservationSource}</span>
      <span>Frigate: {tenant.settingsSummary.frigateBaseUrl || "-"}</span>
      <span>Stripe: {tenant.settingsSummary.stripeConnected ? "Connected" : "Off"}</span>
      <span>Telegram: {tenant.settingsSummary.telegramEnabled ? "On" : "Off"}</span>
      <span>
        Rooms: {tenant.settingsSummary.rooms} - Keys: {tenant.settingsSummary.keys}
      </span>
    </div>
  );
}

function TenantUsers({
  tenant,
  onReload,
  onNotice,
}: {
  tenant: AdminTenantSummary;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  return (
    <UserManagementPanel
      compact
      members={tenant.users}
      invitations={tenant.invitations || []}
      onInvite={(input) => createAdminTenantInvitation(tenant.id, input)}
      onChangeRole={(membershipId, role) =>
        updateAdminTenantMembershipRole(tenant.id, membershipId, role).then(() => undefined)
      }
      onChangeAlias={(membershipId, alias) =>
        updateAdminTenantMembershipAlias(tenant.id, membershipId, alias).then(() => undefined)
      }
      onRevokeMember={(membershipId) =>
        revokeAdminTenantMembership(tenant.id, membershipId).then(() => undefined)
      }
      onGetInvitationLink={(invitationId) => getAdminTenantInvitationLink(tenant.id, invitationId)}
      onRevokeInvitation={(invitationId) =>
        revokeAdminTenantInvitation(tenant.id, invitationId).then(() => undefined)
      }
      onRegenerateInvitation={(invitationId) =>
        regenerateAdminTenantInvitation(tenant.id, invitationId)
      }
      onRefresh={onReload}
      onNotice={onNotice}
    />
  );
}

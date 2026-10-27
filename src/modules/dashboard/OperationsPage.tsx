import { useAuth } from "../../auth/AuthContext";
import { useI18n } from "../../i18n";
import type { ModuleId } from "../../types/modules";
export function OperationsPage({
  enabledModules,
}: {
  enabledModules: Record<ModuleId, boolean>;
}) {
  const { session, activeTenantId } = useAuth(),
    { t } = useI18n();
  const hotel = session?.tenants.find((h) => h.id === activeTenantId),
    base = "/t/" + encodeURIComponent(hotel?.slug || "");
  return (
    <section className="module-page">
      <div className="module-title">
        <div>
          <h1>{t("operations")}</h1>
          <p>{hotel?.name}</p>
        </div>
      </div>
      <div className="hb-device-cards">
        {enabledModules.checkout && (
          <article className="panel">
            <h2>{t("checkout")}</h2>
            <a href={base + "/checkout"}>{t("checkout")}</a>
          </article>
        )}
        {enabledModules.parking && (
          <article className="panel">
            <h2>{t("parking")}</h2>
            <a href={base + "/parking"}>{t("parking")}</a>
          </article>
        )}
        {!enabledModules.checkout && !enabledModules.parking && (
          <p>No hay módulos operativos activados para este hotel.</p>
        )}
      </div>
    </section>
  );
}

import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "en" | "de" | "es";

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Espanol" },
];

export type TranslationKey =
  | "appName" | "checkOut" | "hotelCheckout" | "scanInstruction" | "scanKey" | "scanning"
  | "readyTitle" | "readyBody" | "room" | "confirmCheckout" | "completed" | "completedBody"
  | "duplicate" | "invalidQr" | "deactivatedQr" | "networkError" | "checkoutUnavailable"
  | "cameraError" | "language" | "loginSubtitle" | "email" | "password" | "signIn"
  | "dashboard" | "home" | "housekeeping" | "operations" | "team" | "more" | "profile"
  | "admin" | "settings" | "parking" | "checkout" | "reservations" | "logout" | "today"
  | "roomsToClean" | "checkoutsToday" | "parkingToday" | "currentReservations" | "pending"
  | "inProgress" | "done" | "all" | "unassigned" | "mine" | "manualCheckout" | "refresh"
  | "bed" | "cleaning" | "finish" | "claim" | "assignRoom" | "assigned" | "notAssigned"
  | "accessCode" | "details" | "recentActivity" | "secondaryTools" | "notifications"
  | "enabled" | "disabled" | "activateNotifications" | "deactivateNotifications"
  | "legacyIntegrations" | "username" | "hotelAlias" | "role" | "save" | "saved"
  | "welcomeTitle" | "continue" | "enableNotificationsTitle" | "enableNotificationsBody"
  | "allSet" | "start" | "skip" | "dashboardWidgets" | "supportMode" | "exit"
  | "backToAdmin" | "noRoomsPending" | "averageCleaningToday";

const translations: Record<Locale, Record<TranslationKey, string>> = {
  en: {
    appName: "CICO", checkOut: "Check out", hotelCheckout: "Hotel checkout",
    scanInstruction: "Scan the QR code on the back of your key.", scanKey: "Scan key", scanning: "Scanning QR",
    readyTitle: "Ready to check out?", readyBody: "Please make sure the room is empty and you haven't left anything behind.",
    room: "Room", confirmCheckout: "Confirm checkout", completed: "Checkout completed",
    completedBody: "You can leave your key at reception.", duplicate: "Checkout already received recently.",
    invalidQr: "This QR code is invalid.", deactivatedQr: "This QR code has been deactivated.",
    networkError: "Network error. Please try again.", checkoutUnavailable: "Checkout is temporarily unavailable. Please try again.",
    cameraError: "Could not start the camera.", language: "Language", loginSubtitle: "Sign in to manage hotel operations.",
    email: "Email", password: "Password", signIn: "Sign in", dashboard: "Dashboard", home: "Home",
    housekeeping: "Housekeeping", operations: "Operations", team: "Team", more: "More", profile: "Profile",
    admin: "Admin", settings: "Settings", parking: "Parking", checkout: "Checkout", reservations: "Reservations",
    logout: "Logout", today: "Today", roomsToClean: "To clean", checkoutsToday: "Checkouts", parkingToday: "Parking",
    currentReservations: "Reservations", pending: "Pending", inProgress: "In progress", done: "Done", all: "All",
    unassigned: "Unassigned", mine: "Mine", manualCheckout: "Manual checkout", refresh: "Refresh", bed: "Bed",
    cleaning: "Cleaning", finish: "Finish", claim: "I will do it", assignRoom: "Assign room", assigned: "Assigned",
    notAssigned: "Not assigned", accessCode: "Code", details: "Details", recentActivity: "Recent Activity",
    secondaryTools: "Secondary tools", notifications: "Notifications", enabled: "Enabled", disabled: "Disabled",
    activateNotifications: "Activate notifications", deactivateNotifications: "Disable notifications",
    legacyIntegrations: "Legacy integrations", username: "Username", hotelAlias: "Hotel alias", role: "Role",
    save: "Save", saved: "Saved.", welcomeTitle: "Welcome to HotelApp", continue: "Continue",
    enableNotificationsTitle: "Activate notifications", enableNotificationsBody: "We will notify you about new rooms and assigned tasks.",
    allSet: "All set", start: "Start", skip: "Skip", dashboardWidgets: "Dashboard widgets",
    supportMode: "Support mode", exit: "Exit", backToAdmin: "Back to Platform Admin",
    noRoomsPending: "No rooms pending.", averageCleaningToday: "Average cleaning today",
  },
  de: {
    appName: "CICO", checkOut: "Auschecken", hotelCheckout: "Hotel-Checkout",
    scanInstruction: "Scannen Sie den QR-Code auf der Rueckseite Ihres Schluessels.", scanKey: "Schluessel scannen",
    scanning: "QR wird gescannt", readyTitle: "Bereit zum Auschecken?",
    readyBody: "Bitte stellen Sie sicher, dass das Zimmer leer ist und Sie nichts vergessen haben.",
    room: "Zimmer", confirmCheckout: "Checkout bestaetigen", completed: "Checkout abgeschlossen",
    completedBody: "Sie koennen den Schluessel an der Rezeption abgeben.", duplicate: "Checkout wurde kuerzlich bereits empfangen.",
    invalidQr: "Dieser QR-Code ist ungueltig.", deactivatedQr: "Dieser QR-Code wurde deaktiviert.",
    networkError: "Netzwerkfehler. Bitte versuchen Sie es erneut.", checkoutUnavailable: "Checkout ist voruebergehend nicht verfuegbar. Bitte versuchen Sie es erneut.",
    cameraError: "Die Kamera konnte nicht gestartet werden.", language: "Sprache", loginSubtitle: "Bei HotelApp anmelden.",
    email: "E-Mail", password: "Passwort", signIn: "Anmelden", dashboard: "Dashboard", home: "Start",
    housekeeping: "Housekeeping", operations: "Betrieb", team: "Team", more: "Mehr", profile: "Profil",
    admin: "Admin", settings: "Einstellungen", parking: "Parking", checkout: "Checkout", reservations: "Reservierungen",
    logout: "Abmelden", today: "Heute", roomsToClean: "Zu reinigen", checkoutsToday: "Checkouts", parkingToday: "Parking",
    currentReservations: "Reservierungen", pending: "Offen", inProgress: "In Arbeit", done: "Fertig", all: "Alle",
    unassigned: "Ohne Zuweisung", mine: "Meine", manualCheckout: "Manueller Checkout", refresh: "Aktualisieren",
    bed: "Bett", cleaning: "Reinigung", finish: "Fertig", claim: "Ich uebernehme", assignRoom: "Zimmer zuweisen",
    assigned: "Zugewiesen", notAssigned: "Nicht zugewiesen", accessCode: "Code", details: "Details",
    recentActivity: "Letzte Aktivitaet", secondaryTools: "Weitere Werkzeuge", notifications: "Benachrichtigungen",
    enabled: "Aktiv", disabled: "Inaktiv", activateNotifications: "Benachrichtigungen aktivieren",
    deactivateNotifications: "Benachrichtigungen deaktivieren", legacyIntegrations: "Legacy-Integrationen",
    username: "Username", hotelAlias: "Hotel-Alias", role: "Rolle", save: "Speichern", saved: "Gespeichert.",
    welcomeTitle: "Willkommen bei HotelApp", continue: "Weiter", enableNotificationsTitle: "Benachrichtigungen aktivieren",
    enableNotificationsBody: "Wir informieren Sie ueber neue Zimmer und zugewiesene Aufgaben.",
    allSet: "Alles bereit", start: "Starten", skip: "Ueberspringen", dashboardWidgets: "Dashboard-Bloecke",
    supportMode: "Support-Modus", exit: "Beenden", backToAdmin: "Zurueck zu Platform Admin",
    noRoomsPending: "Keine Zimmer offen.", averageCleaningToday: "Durchschnitt Reinigung heute",
  },
  es: {
    appName: "CICO", checkOut: "Checkout", hotelCheckout: "Checkout del hotel",
    scanInstruction: "Escanea el codigo QR del reverso de tu llave.", scanKey: "Escanear llave", scanning: "Escaneando QR",
    readyTitle: "Listo para hacer checkout?", readyBody: "Asegurate de que la habitacion este vacia y de no haber olvidado nada.",
    room: "Habitacion", confirmCheckout: "Confirmar checkout", completed: "Checkout completado",
    completedBody: "Puedes dejar la llave en recepcion.", duplicate: "El checkout ya se recibio recientemente.",
    invalidQr: "Este codigo QR no es valido.", deactivatedQr: "Este codigo QR esta desactivado.",
    networkError: "Error de red. Intentalo de nuevo.", checkoutUnavailable: "El checkout no esta disponible temporalmente. Intentalo de nuevo.",
    cameraError: "No se pudo iniciar la camara.", language: "Idioma", loginSubtitle: "Inicia sesion para gestionar operaciones del hotel.",
    email: "Email", password: "Contrasena", signIn: "Entrar", dashboard: "Dashboard", home: "Inicio",
    housekeeping: "Housekeeping", operations: "Operaciones", team: "Equipo", more: "Mas", profile: "Perfil",
    admin: "Admin", settings: "Ajustes", parking: "Parking", checkout: "Checkout", reservations: "Reservas",
    logout: "Salir", today: "Hoy", roomsToClean: "Por limpiar", checkoutsToday: "Checkouts", parkingToday: "Parking",
    currentReservations: "Reservas", pending: "Pendientes", inProgress: "En progreso", done: "Terminadas", all: "Todas",
    unassigned: "Sin asignar", mine: "Mias", manualCheckout: "Checkout manual", refresh: "Actualizar", bed: "Cama",
    cleaning: "Limpieza", finish: "Finalizar", claim: "Me encargo", assignRoom: "Asignar habitacion", assigned: "Asignada",
    notAssigned: "Sin asignar", accessCode: "Codigo", details: "Detalles", recentActivity: "Actividad reciente",
    secondaryTools: "Herramientas secundarias", notifications: "Notificaciones", enabled: "Activadas", disabled: "Desactivadas",
    activateNotifications: "Activar notificaciones", deactivateNotifications: "Desactivar notificaciones",
    legacyIntegrations: "Integraciones heredadas", username: "Username", hotelAlias: "Alias en el hotel", role: "Rol",
    save: "Guardar", saved: "Guardado.", welcomeTitle: "Bienvenido a HotelApp", continue: "Continuar",
    enableNotificationsTitle: "Activa las notificaciones", enableNotificationsBody: "Te avisaremos de nuevas habitaciones y tareas asignadas.",
    allSet: "Todo listo", start: "Empezar", skip: "Omitir", dashboardWidgets: "Bloques del Dashboard",
    supportMode: "Support mode", exit: "Salir", backToAdmin: "Volver a Platform Admin",
    noRoomsPending: "No hay habitaciones pendientes.", averageCleaningToday: "Media limpieza hoy",
  },
};

const STORAGE_KEY = "hotelapp.locale";

export function getBrowserLocale(): Locale {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    const normalized = String(language || "").toLowerCase();
    if (normalized.startsWith("de")) return "de";
    if (normalized.startsWith("es")) return "es";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}

export function getStoredLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
  return stored && LOCALES.some((locale) => locale.id === stored) ? stored : "en";
}

export function t(locale: Locale, key: TranslationKey) {
  return translations[locale]?.[key] || translations.en[key];
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getStoredLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale(nextLocale) {
        localStorage.setItem(STORAGE_KEY, nextLocale);
        setLocaleState(nextLocale);
      },
      t: (key) => t(locale, key),
    }),
    [locale],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider.");
  }
  return context;
}

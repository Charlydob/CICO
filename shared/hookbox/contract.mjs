import fontMetrics from "./font-metrics.json" with { type: "json" };
export function textWidth(s, size = 20) {
  return [...s].reduce(
    (n, c) => n + (fontMetrics[String(size)][c.codePointAt(0)] ?? 1600000) / 16,
    0,
  );
}
export const TEXT_WIDTHS = {
  welcome: [40, 500],
  subtitle: [20, 460],
  id: [20, 186],
  surname: [20, 198],
  placeholderId: [20, 248],
  placeholderSurname: [20, 248],
  search: [20, 148],
  verify: [20, 204],
  verificationHelp: [20, 752],
  confirm: [20, 626],
  searching: [28, 704],
  error: [28, 704],
  room: [28, 180],
  delivery: [28, 704],
  done: [28, 704],
  home: [20, 112],
  qrHelp: [14, 196],
  space: [20, 236],
  shift: [20, 86],
  delete: [20, 96],
};
import geometry from "./geometry.json" with { type: "json" };
export const GEOMETRY = Object.freeze(geometry);
export const LANGUAGES = ["de", "en", "fr", "es"];
export const LIMITS = Object.freeze({
  width: 800,
  height: 480,
  jsonBytes: 12288,
  assetBytes: 32768,
  totalAssetBytes: 65536,
  logoWidth: 160,
  logoHeight: 64,
  backgroundWidth: 160,
  backgroundHeight: 96,
});
export const TEXT_KEYS = [
  "welcome",
  "subtitle",
  "id",
  "surname",
  "placeholderId",
  "placeholderSurname",
  "search",
  "verify",
  "verificationHelp",
  "confirm",
  "searching",
  "error",
  "room",
  "delivery",
  "done",
  "home",
  "qrHelp",
  "space",
  "shift",
  "delete",
];
const base = {
  de: [
    "Willkommen",
    "Bitte identifizieren Sie Ihre Buchung",
    "Check-in-ID",
    "Nachname",
    "PIN",
    "Ihr Nachname",
    "OK",
    "Prüfen",
    "Bestätigungscode eingeben",
    "Schlüssel freigeben",
    "PIN wird geprüft",
    "Bitte Rezeption kontaktieren",
    "Zimmer",
    "Schlüssel werden bereitgestellt",
    "Vorgang abgeschlossen",
    "Start",
  ],
  en: [
    "Welcome",
    "Please identify your booking",
    "Check-in ID",
    "Surname",
    "PIN",
    "Your surname",
    "OK",
    "Verify",
    "Enter your verification code",
    "Release key",
    "Checking PIN",
    "Please contact reception",
    "Room",
    "Preparing your keys",
    "Process completed",
    "Home",
  ],
  fr: [
    "Bienvenue",
    "Identifiez votre réservation",
    "ID de check-in",
    "Nom",
    "PIN",
    "Votre nom",
    "OK",
    "Vérifier",
    "Votre code de vérification",
    "Libérer la clé",
    "Vérification du PIN",
    "Veuillez contacter la réception",
    "Chambre",
    "Préparation des clés",
    "Opération terminée",
    "Accueil",
  ],
  es: [
    "Bienvenido",
    "Identifica tu reserva",
    "Check-in-ID",
    "Apellido",
    "PIN",
    "Tu apellido",
    "Confirmar",
    "Verificar",
    "Tu código de verificación",
    "Liberar llave",
    "Comprobando PIN",
    "Contacta con recepción",
    "Habitación",
    "Preparando tus llaves",
    "Proceso finalizado",
    "Inicio",
  ],
};
const extra = {
  de: ["Mit dem Handy", "Leerzeichen", "Groß", "Löschen"],
  en: ["Continue on phone", "Space", "Shift", "Delete"],
  fr: ["Sur votre mobile", "Espace", "Maj.", "Effacer"],
  es: ["En tu móvil", "Espacio", "Mayús.", "Borrar"],
};
for (const l of LANGUAGES) base[l].push(...extra[l]);
export function defaultTheme(hotelName = "Hotel") {
  return {
    schemaVersion: 1,
    width: 800,
    height: 480,
    hotelName,
    template: "guest-portal",
    font: "latin",
    defaultLanguage: "de",
    colors: {
      background: "#080706",
      surface: "#2f2922",
      primary: "#c4a574",
      text: "#ebe4d7",
      buttonText: "#18150f",
      secondary: "#b7ab96",
      inputBackground: "#19160f",
      inputText: "#ebe4d7",
      inputBorder: "#6c5939",
    },
    qr: {
      enabled: false,
      data: "https://example.com",
      size: 160,
      x: 592,
      y: 160,
      margin: 8,
    },
    logo: null,
    background: null,
    idleMs: 60000,
    returnMs: 9000,
    texts: Object.fromEntries(
      LANGUAGES.map((l) => [
        l,
        Object.fromEntries(TEXT_KEYS.map((k, i) => [k, base[l][i]])),
      ]),
    ),
  };
}
export function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}
export function upgradeTheme(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const theme = JSON.parse(JSON.stringify(raw));
  if (["classic-left", "classic-right"].includes(theme.template)) {
    const defaults = defaultTheme(theme.hotelName);
    theme.template = "guest-portal";
    theme.colors = { ...defaults.colors, ...theme.colors };
    for (const l of LANGUAGES)
      theme.texts[l] = { ...defaults.texts[l], ...theme.texts?.[l] };
  }
  theme.qr = { x: 592, y: 160, margin: 8, ...theme.qr };
  const original = defaultTheme(theme.hotelName);
  for (const l of LANGUAGES) {
    const updates = {
      id: "PIN",
      placeholderId: "PIN",
      search: { de: "OK", en: "OK", fr: "OK", es: "Confirmar" }[l],
      searching: {
        de: "PIN wird geprüft",
        en: "Checking PIN",
        fr: "Vérification du PIN",
        es: "Comprobando PIN",
      }[l],
    };
    for (const [key, value] of Object.entries(updates))
      if (
        !theme.texts?.[l]?.[key] ||
        theme.texts[l][key] === original.texts[l][key] ||
        [
          "Your check-in ID",
          "Ihre Check-in-ID",
          "Votre ID de check-in",
          "Tu Check-in-ID",
          "Search",
          "Suchen",
          "Rechercher",
          "Buscar",
          "Searching for booking",
          "Buchung wird gesucht",
          "Recherche en cours",
          "Buscando reserva",
        ].includes(theme.texts[l][key])
      )
        theme.texts[l][key] = value;
  }
  return theme;
}
export function validateTheme(raw) {
  raw = upgradeTheme(raw);
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    raw.width !== 800 ||
    raw.height !== 480
  )
    fail("Unsupported theme schema or display");
  const allowed = Object.keys(defaultTheme());
  if (Object.keys(raw).some((k) => !allowed.includes(k)))
    fail("Unsupported theme field");
  if (
    raw.template !== "guest-portal" ||
    raw.font !== "latin" ||
    !LANGUAGES.includes(raw.defaultLanguage)
  )
    fail("Unsupported template, font or language");
  const text = (s, n) =>
    typeof s === "string" &&
    s.length > 0 &&
    [...s].length <= n &&
    [...s].every((c) => {
      const v = c.codePointAt(0);
      return (
        (v >= 32 && v <= 126) ||
        (v >= 160 && v <= 255) ||
        (v >= 0x11e && v <= 0x11f) ||
        [0x131, 0x141, 0x142, 0x152, 0x153].includes(v)
      );
    });
  if (!text(raw.hotelName, 32) || textWidth(raw.hotelName, 28) > 436)
    fail("Hotel name exceeds font/length limits");
  for (const k of Object.keys(defaultTheme().colors))
    if (!/^#[0-9a-fA-F]{6}$/.test(raw.colors?.[k])) fail("Invalid color " + k);
  for (const l of LANGUAGES)
    for (const k of TEXT_KEYS)
      if (!text(raw.texts?.[l]?.[k], k === "subtitle" ? 48 : 32))
        fail("Unsupported font or text length: " + l + "." + k);
  for (const l of LANGUAGES)
    for (const k of TEXT_KEYS) {
      const [size, width] = TEXT_WIDTHS[k];
      if (textWidth(raw.texts[l][k], size) > width)
        fail("Text exceeds firmware width: " + l + "." + k);
    }
  if (
    !Number.isInteger(raw.idleMs) ||
    raw.idleMs < 15000 ||
    raw.idleMs > 300000 ||
    !Number.isInteger(raw.returnMs) ||
    raw.returnMs < 3000 ||
    raw.returnMs > 30000
  )
    fail("Unsafe UI timeout");
  if (
    typeof raw.qr?.enabled !== "boolean" ||
    ![128, 160, 192].includes(raw.qr.size) ||
    typeof raw.qr.data !== "string" ||
    new TextEncoder().encode(raw.qr.data).length > 160 ||
    !raw.qr.data.trim() ||
    /[\x00-\x1f\x7f]/.test(raw.qr.data) ||
    /^(?:javascript|data|file|vbscript):/i.test(raw.qr.data) ||
    (raw.qr.data.includes("://") && !/^https:\/\/[^\s]+$/.test(raw.qr.data))
  )
    fail("QR requires safe content and a supported size");
  const { x, y, margin, size } = raw.qr;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(margin) ||
    margin < 4 ||
    margin > 16 ||
    x - margin < 0 ||
    x + size + margin > 800 ||
    y - margin < 0 ||
    y + size + margin > 480
  )
    fail("QR fuera de la pantalla o margen inválido");
  const keypadX = raw.qr.enabled ? (x < 400 ? 312 : 48) : 180;
  if (
    raw.qr.enabled &&
    x - margin < keypadX + 440 &&
    x + size + margin > keypadX &&
    y - margin < 454 &&
    y + size + margin > 64
  )
    fail("El QR invade el teclado PIN; muévelo a un lado");
  for (const k of ["logo", "background"])
    if (raw[k] !== null && !/^[a-f0-9]{64}$/.test(raw[k]))
      fail("Invalid asset digest");
  if (new TextEncoder().encode(JSON.stringify(raw)).length > LIMITS.jsonBytes)
    fail("Theme too large");
  return JSON.parse(JSON.stringify(raw));
}
export function validateQuery(input) {
  if (
    input?.schemaVersion !== 1 ||
    !LANGUAGES.includes(input.language) ||
    !["id", "surname"].includes(input.method) ||
    typeof input.value !== "string" ||
    input.value.trim().length < 2 ||
    input.value.length > 64 ||
    /[\x00-\x1f]/.test(input.value)
  )
    fail("Invalid lookup");
  if (
    typeof input.operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.operationId,
    )
  )
    fail("operationId must be UUID v4");
  return { ...input, value: input.value.trim() };
}
export function authorizedRooms(response) {
  if (
    response?.schemaVersion !== 1 ||
    response.authorized !== true ||
    response.identityVerified !== true ||
    response.conditionsSatisfied !== true ||
    typeof response.reservationId !== "string" ||
    !response.reservationId ||
    response.reservationId.length > 128 ||
    !Array.isArray(response.rooms) ||
    !response.rooms.length ||
    response.rooms.length > 25
  )
    fail("Check-in provider did not authorize delivery", 403);
  const rooms = response.rooms.map((x) => String(x));
  if (
    new Set(rooms).size !== rooms.length ||
    rooms.some((x) => !x || x.length > 16 || !/^[-A-Za-z0-9 ]+$/.test(x))
  )
    fail("Invalid authorized rooms", 502);
  return rooms;
}
export function validateMapping(raw) {
  if (!Array.isArray(raw) || raw.length > 25) fail("Invalid room mapping");
  const rooms = new Set(),
    hooks = new Set();
  for (const r of raw) {
    if (
      typeof r.room !== "string" ||
      !/^[-A-Za-z0-9 ]{1,16}$/.test(r.room) ||
      !Number.isInteger(r.hook) ||
      r.hook < 1 ||
      r.hook > 25 ||
      rooms.has(r.room) ||
      hooks.has(r.hook)
    )
      fail("Room/hook mapping must be unique");
    rooms.add(r.room);
    hooks.add(r.hook);
  }
  return raw.map(({ room, hook }) => ({ room, hook }));
}

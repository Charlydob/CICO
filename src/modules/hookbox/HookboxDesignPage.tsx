import { renderGuestPortal } from "./drawGuestPortal";
import { useEffect, useRef, useState } from "react";
import {
  defaultTheme,
  upgradeTheme,
  validateTheme,
  LANGUAGES,
  TEXT_KEYS,
  GEOMETRY as G,
  type Theme,
} from "../../../shared/hookbox/contract.mjs";
import { hookboxRequest, hookboxAsset } from "../../services/backendApi";
import "./hookbox.css";
type Version = {
  id: string;
  createdAt: string;
  manifest: { theme: Theme; roomMapping?: { room: string; hook: number }[] };
};
type Editor = {
  hotel: {
    draft: Theme;
    revision: number;
    mapping: { room: string; hook: number }[];
    publishedVersion: string | null;
  };
  versions: Version[];
  devices: {
    id: string;
    name: string;
    uiDesiredVersion: string | null;
    uiAppliedVersion: string | null;
    uiRejectedReason: string | null;
    events?: {
      id: string;
      type: string;
      detail: string | null;
      createdAt: string;
    }[];
  }[];
};
const textLabels: Record<string, string> = {
  welcome: "Bienvenida",
  subtitle: "Subtítulo",
  id: "Etiqueta de Check-in ID",
  surname: "Etiqueta de apellido",
  placeholderId: "Ejemplo del identificador",
  placeholderSurname: "Ejemplo del apellido",
  search: "Botón de búsqueda",
  verify: "Botón de verificación",
  verificationHelp: "Instrucciones de verificación",
  confirm: "Confirmar entrega",
  searching: "Buscando reserva",
  error: "Mensaje de error",
  room: "Habitación",
  delivery: "Entrega en curso",
  done: "Entrega terminada",
  home: "Volver al inicio",
  qrHelp: "Texto bajo el QR",
  space: "Teclado: espacio",
  shift: "Teclado: mayúsculas",
  delete: "Teclado: borrar",
};
const keys = G.rows;
async function rgbUrl(a: {
  bytes: ArrayBuffer;
  width: number;
  height: number;
}) {
  const c = document.createElement("canvas");
  c.width = a.width;
  c.height = a.height;
  const ctx = c.getContext("2d")!,
    im = ctx.createImageData(c.width, c.height),
    bytes = new Uint8Array(a.bytes);
  for (let i = 0; i < c.width * c.height; i++) {
    const n = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    im.data.set(
      [
        (((n >> 11) & 31) * 255) / 31,
        (((n >> 5) & 63) * 255) / 63,
        ((n & 31) * 255) / 31,
        255,
      ],
      i * 4,
    );
  }
  ctx.putImageData(im, 0, 0);
  return c.toDataURL();
}
export function HookboxDesignPage({ deviceId }: { deviceId?: string } = {}) {
  const [contentKey, setContentKey] = useState("welcome");
  const [mode, setMode] = useState<"preview" | "edit">("preview"),
    [category, setCategory] = useState("Contenido"),
    [selection, setSelection] = useState<{
      key?: string;
      color: string;
      label: string;
      rect: number[];
    }>();
  const [selectedDevice, setSelectedDevice] = useState(deviceId || ""),
    [traces, setTraces] = useState<
      {
        id: string;
        path: string;
        status: number;
        createdAt: string;
        request: unknown;
        response: unknown;
      }[]
    >([]),
    [data, setData] = useState<Editor>(),
    [theme, setTheme] = useState(defaultTheme()),
    [lang, setLang] = useState("de"),
    [screen, setScreen] = useState("home"),
    [method, setMethod] = useState("id"),
    [value, setValue] = useState(""),
    [shift, setShift] = useState(false),
    [accents, setAccents] = useState(0),
    [fontsReady, setFontsReady] = useState(0),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [mapping, setMapping] = useState("101:1\n102:2"),
    [images, setImages] = useState<Record<string, string>>({});
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (mode === "edit") return;
    if (screen === "waiting") {
      const timer = setTimeout(() => setScreen("verify"), 600);
      return () => clearTimeout(timer);
    }
    if (screen === "delivery") {
      const timer = setTimeout(() => setScreen("done"), 2000);
      return () => clearTimeout(timer);
    }
    if (screen !== "home") {
      const timer = setTimeout(
        () => setScreen("home"),
        screen === "done" ? theme.returnMs : theme.idleMs,
      );
      return () => clearTimeout(timer);
    }
  }, [mode, screen, theme.idleMs, theme.returnMs, value]);
  const texts = theme.texts[lang];
  useEffect(() => {
    void document.fonts
      .load("500 20px Montserrat")
      .then(() => setFontsReady(1));
  }, []);
  async function load(deviceId = selectedDevice) {
    const d = await hookboxRequest<Editor>(
      "editor" + (deviceId ? "?deviceId=" + encodeURIComponent(deviceId) : ""),
    );
    setData(d);
    setTheme(upgradeTheme(d.hotel.draft));
    setLang(d.hotel.draft.defaultLanguage);
    setMapping(d.hotel.mapping.map((r) => `${r.room}:${r.hook}`).join("\n"));
  }
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, []);
  useEffect(() => {
    let active = true;
    for (const id of [theme.logo, theme.background])
      if (id && !images[id])
        void hookboxAsset(id)
          .then(rgbUrl)
          .then((url) => {
            if (active) setImages((x) => ({ ...x, [id]: url }));
          })
          .catch((e) => setMessage(e.message));
    return () => {
      active = false;
    };
  }, [theme.logo, theme.background, images]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const update = (patch: Partial<Theme>) =>
    setTheme((t) => ({ ...t, ...patch }));
  function roomMap() {
    return mapping
      .split("\n")
      .filter((x) => x.trim())
      .map((x) => {
        const [room, hook] = x.split(":");
        return { room: room.trim(), hook: Number(hook) };
      });
  }
  async function save() {
    validateTheme(theme);
    const h = await hookboxRequest<Editor["hotel"]>("draft", {
      deviceId: selectedDevice || undefined,
      revision: data!.hotel.revision,
      theme,
      mapping: roomMap(),
    });
    setData((d) => ({ ...d!, hotel: h }));
    return h;
  }
  async function upload(file: File, kind: "logo" | "background") {
    if (
      !["image/png", "image/jpeg"].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    )
      throw Error("Carga PNG/JPG de hasta 4 MB; SVG no está soportado");
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 16000000) {
      bitmap.close();
      throw Error("Imagen demasiado grande");
    }
    const ratio = Math.min(
        1,
        160 / bitmap.width,
        (kind === "logo" ? 64 : 96) / bitmap.height,
      ),
      c = document.createElement("canvas");
    c.width = Math.max(1, Math.floor(bitmap.width * ratio));
    c.height = Math.max(1, Math.floor(bitmap.height * ratio));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = theme.colors.background;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, c.width, c.height).data,
      bytes = new Uint8Array(c.width * c.height * 2);
    for (let i = 0; i < c.width * c.height; i++) {
      const n =
        ((rgba[4 * i] >> 3) << 11) |
        ((rgba[4 * i + 1] >> 2) << 5) |
        (rgba[4 * i + 2] >> 3);
      bytes[2 * i] = n & 255;
      bytes[2 * i + 1] = n >> 8;
    }
    const a = await hookboxRequest<{ id: string }>("assets", {
      kind,
      width: c.width,
      height: c.height,
      data: btoa(String.fromCharCode(...bytes)),
    });
    setImages((x) => ({ ...x, [a.id]: c.toDataURL() }));
    update({ [kind]: a.id });
    return a.id;
  }
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    let cancelled = false;
    renderGuestPortal(
      ctx,
      theme,
      { lang, screen, method, value, shift, accents, images },
      () => !cancelled,
    );
    return () => {
      cancelled = true;
    };
  }, [theme, lang, screen, method, value, shift, accents, images, fontsReady]);
  useEffect(() => {
    const reveal = () => {
      if (
        mode === "edit" &&
        selection &&
        window.matchMedia("(max-width:900px)").matches
      )
        canvas.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    reveal();
    window.visualViewport?.addEventListener("resize", reveal);
    window.addEventListener("resize", reveal);
    return () => {
      window.visualViewport?.removeEventListener("resize", reveal);
      window.removeEventListener("resize", reveal);
    };
  }, [mode, selection]);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function stopHold() {
    if (hold.current) clearTimeout(hold.current);
    hold.current = undefined;
  }
  useEffect(() => () => stopHold(), []);
  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * 800) / r.width,
      y: ((e.clientY - r.top) * 480) / r.height,
    };
  }
  function startHold(e: React.PointerEvent<HTMLCanvasElement>) {
    stopHold();
    if (mode === "edit") return;
    const { x, y } = canvasPoint(e);
    if (x >= 24 && x <= 548 && y >= 16 && y <= 72)
      hold.current = setTimeout(() => setScreen("service"), 5000);
  }

  function click(e: React.MouseEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect(),
      x = ((e.clientX - r.left) * 800) / r.width,
      y = ((e.clientY - r.top) * 480) / r.height;
    if (mode === "edit") {
      let hit: { key?: string; color: string; label: string; rect: number[] } =
        { color: "background", label: "Fondo", rect: [0, 0, 800, 480] };
      if (y >= 16 && y <= 72 && x < 548)
        hit =
          x < 100 && theme.logo
            ? { color: "background", label: "Logotipo", rect: [24, 16, 72, 56] }
            : {
                key: "hotelName",
                color: "primary",
                label: "Nombre del hotel",
                rect: [theme.logo ? 112 : 24, 25, 436, 42],
              };
      else if (y >= 100 && y < 150 && x < 540)
        hit = {
          key: "welcome",
          color: "primary",
          label: "Bienvenida",
          rect: [24, 100, 500, 48],
        };
      else if (screen === "home") {
        if (y >= 153 && y < 180 && x < 530)
          hit = {
            key: "subtitle",
            color: "secondary",
            label: "Subtítulo",
            rect: [24, 153, 500, 28],
          };
        else if (x >= 548 && y >= 204 && y < 444) {
          hit =
            y >= 420
              ? {
                  key: "qrHelp",
                  color: "secondary",
                  label: "Texto del QR",
                  rect: [564, 424, 196, 18],
                }
              : {
                  color: "surface",
                  label: "Código QR",
                  rect: [548, 204, 228, 240],
                };
          setCategory("QR y branding");
        } else if (x >= 24 && x <= 524 && y >= 204 && y <= 444) {
          const second = y >= 332,
            top = second ? 332 : 204;
          hit =
            y < top + 40
              ? {
                  key: second ? "surname" : "id",
                  color: "primary",
                  label: "Etiqueta del campo",
                  rect: [44, top + 16, 272, 28],
                }
              : x >= 332
                ? {
                    key: "search",
                    color: "buttonText",
                    label: "Botón de búsqueda",
                    rect: [332, top + 46, 172, 48],
                  }
                : y >= top + 46 && y <= top + 94
                  ? {
                      key: second ? "placeholderSurname" : "placeholderId",
                      color: "secondary",
                      label: "Ejemplo del campo",
                      rect: [44, top + 46, 272, 48],
                    }
                  : {
                      color: "surface",
                      label: "Tarjeta",
                      rect: [24, top, 500, 112],
                    };
        }
      } else if (screen === "form" || screen === "verify") {
        if (y >= 152 && y < 196)
          hit = {
            key:
              screen === "verify"
                ? "verificationHelp"
                : x < 274
                  ? "id"
                  : "surname",
            color: screen === "verify" ? "secondary" : "buttonText",
            label: "Texto del formulario",
            rect: [24, 152, 752, 44],
          };
        else if (y >= 204 && y <= 252)
          hit =
            x >= 548
              ? {
                  key: screen === "verify" ? "verify" : "search",
                  color: "buttonText",
                  label: "Botón de búsqueda",
                  rect: [548, 204, 228, 48],
                }
              : {
                  key:
                    screen === "form"
                      ? method === "id"
                        ? "placeholderId"
                        : "placeholderSurname"
                      : undefined,
                  color: "inputBackground",
                  label: "Campo de identificación",
                  rect: [24, 204, 500, 48],
                };
        else if (y >= 270 && y < 438)
          hit = {
            color: "surface",
            label: "Teclado",
            rect: [24, 270, 752, 168],
          };
        else if (y >= 444)
          hit = {
            key:
              x >= G.home[0]
                ? "home"
                : x >= G.delete[0]
                  ? "delete"
                  : x >= G.accents[0]
                    ? undefined
                    : x >= G.shift[0]
                      ? "shift"
                      : "space",
            color: x >= G.home[0] ? "buttonText" : "text",
            label: "Teclado",
            rect: [24, 444, 752, 38],
          };
      } else if (
        ["authorized", "delivery", "done", "error", "waiting"].includes(
          screen,
        ) &&
        y >= 176 &&
        y < 380
      ) {
        const key =
          screen === "authorized"
            ? "confirm"
            : screen === "done"
              ? "done"
              : screen === "error"
                ? "error"
                : screen === "delivery"
                  ? "delivery"
                  : "searching";
        hit = {
          key:
            y < 232 && ["authorized", "delivery", "done"].includes(screen)
              ? "room"
              : key,
          color:
            y < 232 && ["authorized", "delivery", "done"].includes(screen)
              ? "primary"
              : "text",
          label: "Texto de la pantalla",
          rect: [48, y < 232 ? 194 : 252, 704, 40],
        };
      }
      if (hit.key && hit.key !== "hotelName") setContentKey(hit.key);
      setSelection(hit);
      return;
    }
    if (
      screen !== "service" &&
      y >= G.languages[1] &&
      y <= G.languages[1] + G.languages[4] &&
      x >= G.languages[0] &&
      x <= 776
    ) {
      const l = LANGUAGES[Math.floor((x - G.languages[0]) / G.languages[2])];
      if (l) setLang(l);
    } else if (
      screen === "home" &&
      x >= 24 &&
      x <= 524 &&
      ((y >= 204 && y <= 316) || (y >= 332 && y <= 444))
    ) {
      setMethod(y < 332 ? "id" : "surname");
      setValue("");
      setScreen("form");
    } else if (screen === "form" || screen === "verify") {
      if (y >= 152 && y < 196 && screen === "form") {
        setMethod(x < 274 ? "id" : "surname");
        setValue("");
      }
      if (y >= 204 && y < 252 && x >= 548 && value.trim()) {
        setValue("");
        setScreen(screen === "form" ? "waiting" : "authorized");
      }
      if (y >= 270 && y < 438) {
        const row = Math.floor((y - G.keyboard[1]) / G.keyboard[3]),
          i = Math.floor((x - G.keyboard[0]) / G.keyboard[2]);
        const k = (
          accents && row === 3
            ? accents === 1
              ? G.accentKeys
              : G.symbolKeys
            : [...(keys[row] || "")]
        )[i];
        if (k)
          setValue((v) =>
            (v + (shift && k !== "ß" ? k.toLocaleUpperCase() : k)).slice(0, 64),
          );
      }
      if (y >= G.footerY) {
        if (x < G.shift[0]) setValue((v) => (v + " ").slice(0, 64));
        else if (x < G.accents[0]) setShift((v) => !v);
        else if (x < G.delete[0]) setAccents((v) => (v + 1) % 3);
        else if (x < G.home[0]) setValue((v) => v.slice(0, -1));
        else setScreen("home");
      }
    } else if (
      screen === "authorized" &&
      x >= 48 &&
      x <= 698 &&
      y >= 310 &&
      y <= 358
    )
      setScreen("delivery");
    else if (screen === "delivery") setScreen("done");
    else if (y >= 390) setScreen("home");
  }
  if (!data)
    return (
      <section>
        <h1>Hookbox · Diseño de pantalla</h1>
        <p>{message || "Cargando…"}</p>
      </section>
    );
  let validation = "";
  try {
    validateTheme(theme);
  } catch (e) {
    validation = (e as Error).message;
  }
  return (
    <section className="hb-editor">
      {deviceId && (
        <a href={window.location.pathname.replace(/\/screen\/?$/, "")}>
          Volver al dispositivo
        </a>
      )}
      <h1>Personalizar pantalla</h1>
      <p>Vista previa de la pantalla instalada · 800 × 480</p>
      <p>
        Hotel seleccionado en CICO. Publicación remota independiente del
        firmware.
      </p>
      <label>
        Configuración de pantalla
        <select
          aria-label="Configuración de pantalla"
          value={selectedDevice}
          disabled={busy || !!deviceId}
          onChange={(e) => {
            const id = e.target.value;
            setSelectedDevice(id);
            setData(undefined);
            setTraces([]);
            void run(() => load(id));
          }}
        >
          <option value="">Diseño general del hotel</option>
          {data.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <div className="hb-actions">
        {theme.hotelName.toLowerCase().includes("steinbock") && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const response = await fetch("/hookbox/steinbock-logo.png");
                if (!response.ok)
                  throw Error("Logotipo de referencia no disponible");
                const logo = await upload(
                  new File([await response.blob()], "steinbock.png", {
                    type: "image/png",
                  }),
                  "logo",
                );
                const preset = defaultTheme("Guest House Steinbock");
                preset.logo = logo;
                preset.qr.data =
                  "https://checkin.gasthaus-steinbock.ch/guest-login.php?lang=de";
                setTheme(preset);
                setMessage(
                  "Identidad Steinbock cargada como borrador; revisa y publica para aplicarla",
                );
              })
            }
          >
            Aplicar identidad Steinbock
          </button>
        )}
        <button
          disabled={busy || !!validation}
          onClick={() =>
            void run(async () => {
              await save();
              setMessage("Borrador guardado");
            })
          }
        >
          Guardar borrador
        </button>
        <button disabled={busy} onClick={() => void run(() => load())}>
          Restaurar cambios
        </button>
        <button
          disabled={busy || !!validation}
          onClick={() =>
            void run(async () => {
              const h = await save();
              await hookboxRequest("publish", {
                revision: h.revision,
                deviceId: selectedDevice || undefined,
              });
              await load();
              setMessage(
                "Diseño publicado; esperando confirmación de los dispositivos",
              );
            })
          }
        >
          Publicar diseño
        </button>
      </div>
      {selectedDevice && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await hookboxRequest("inherit", { deviceId: selectedDevice });
              await load();
              setMessage(
                "La pantalla vuelve a seguir el diseño general del hotel",
              );
            })
          }
        >
          Usar diseño general del hotel
        </button>
      )}
      <button
        disabled={busy}
        onClick={() => {
          const restored = defaultTheme(theme.hotelName);
          setTheme(restored);
          setLang(restored.defaultLanguage);
          setMessage(
            "Plantilla predeterminada restaurada como borrador; publica para aplicarla",
          );
        }}
      >
        Restaurar plantilla predeterminada
      </button>
      <p role="status">{validation || message}</p>
      <div className="hb-actions" role="group" aria-label="Modo del editor">
        <button
          aria-pressed={mode === "preview"}
          onClick={() => {
            setMode("preview");
            setSelection(undefined);
          }}
        >
          Vista previa
        </button>
        <button aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
          Editar
        </button>
        <span>
          {mode === "edit"
            ? "Selecciona un elemento de la pantalla para modificarlo"
            : "Prueba la navegación sin cambiar el diseño"}
        </span>
      </div>
      <div
        className="hb-category-tabs"
        role="tablist"
        aria-label="Ajustes de pantalla"
      >
        {[
          "Contenido",
          "Colores",
          "Tipografía",
          "Distribución",
          "Pantallas",
          "QR y branding",
        ].map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={category === c}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="hb-grid">
        <div className="hb-fields">
          {mode === "edit" && selection && (
            <section className="hb-context" aria-label="Elemento seleccionado">
              <strong>{selection.label}</strong>
              {selection.key && (
                <label>
                  Texto seleccionado
                  <input
                    value={
                      selection.key === "hotelName"
                        ? theme.hotelName
                        : texts[selection.key]
                    }
                    onChange={(e) =>
                      selection.key === "hotelName"
                        ? update({ hotelName: e.target.value })
                        : update({
                            texts: {
                              ...theme.texts,
                              [lang]: {
                                ...texts,
                                [selection.key!]: e.target.value,
                              },
                            },
                          })
                    }
                  />
                </label>
              )}
              <label>
                Color del elemento
                <input
                  type="color"
                  value={theme.colors[selection.color]}
                  onChange={(e) =>
                    update({
                      colors: {
                        ...theme.colors,
                        [selection.color]: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <small>
                El color se comparte con los elementos del mismo estilo.
              </small>
            </section>
          )}
          <fieldset
            disabled={mode !== "edit"}
            hidden={category !== "Contenido"}
          >
            <legend>Contenido</legend>
            <label>
              Nombre del hotel
              <input
                maxLength={32}
                value={theme.hotelName}
                onChange={(e) => update({ hotelName: e.target.value })}
              />
            </label>
          </fieldset>
          <fieldset
            disabled={mode !== "edit"}
            hidden={category !== "Distribución"}
          >
            <legend>Distribución segura</legend>
            <p>
              800 × 480 del CrowPanel instalado. Posiciones y márgenes fijados
              por el firmware; arrastre todavía no disponible.
            </p>
            <label>
              Plantilla
              <select
                value={theme.template}
                onChange={(e) => update({ template: e.target.value })}
              >
                <option value="guest-portal">Portal de huéspedes</option>
              </select>
            </label>
          </fieldset>
          <fieldset
            disabled={mode !== "edit"}
            hidden={category !== "Tipografía"}
          >
            <legend>Tipografía compatible</legend>
            <p>
              Los tamaños y la alineación individuales requieren una nueva
              versión del contrato y firmware; no se simulan en la vista previa.
            </p>
            <label>
              Tipografía
              <select
                value={theme.font}
                onChange={(e) => update({ font: e.target.value })}
              >
                <option value="latin">Montserrat Latin (14/20/28/40)</option>
              </select>
            </label>
          </fieldset>
          <fieldset disabled={mode !== "edit"} hidden={category !== "Colores"}>
            <legend>Colores</legend>
            {Object.entries(theme.colors).map(([key, val]) => (
              <label key={key}>
                {{
                  text: "Texto",
                  primary: "Botones y acentos",
                  surface: "Tarjetas",
                  background: "Fondo",
                  buttonText: "Texto de botones",
                  secondary: "Subtítulos",
                  inputBackground: "Fondo de campos",
                  inputText: "Texto de campos",
                  inputBorder: "Borde de campos",
                }[key] || key}
                <input
                  type="color"
                  value={val}
                  onChange={(e) =>
                    update({
                      colors: { ...theme.colors, [key]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
          </fieldset>
          <fieldset
            disabled={mode !== "edit"}
            hidden={category !== "QR y branding"}
          >
            <legend>QR y branding</legend>
            {(["logo", "background"] as const).map((kind) => (
              <label key={kind}>
                {kind === "logo"
                  ? "Logotipo (máx. 160 × 64)"
                  : "Decoración (máx. 160 × 96)"}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void run(() => upload(f, kind));
                  }}
                />
                <button onClick={() => update({ [kind]: null })}>Quitar</button>
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={theme.qr.enabled}
                onChange={(e) =>
                  update({ qr: { ...theme.qr, enabled: e.target.checked } })
                }
              />
              Mostrar QR
            </label>
            <label>
              URL o contenido QR
              <input
                value={theme.qr.data}
                onChange={(e) =>
                  update({ qr: { ...theme.qr, data: e.target.value } })
                }
              />
            </label>
            <label>
              Tamaño QR
              <select
                value={theme.qr.size}
                onChange={(e) =>
                  update({ qr: { ...theme.qr, size: Number(e.target.value) } })
                }
              >
                {[128, 160, 192].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset
            disabled={mode !== "edit"}
            hidden={category !== "Contenido"}
          >
            <legend>Idiomas y traducciones</legend>
            <label>
              Idioma inicial
              <select
                value={theme.defaultLanguage}
                onChange={(e) => update({ defaultLanguage: e.target.value })}
              >
                {LANGUAGES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset
            disabled={mode !== "edit"}
            hidden={category !== "Pantallas"}
          >
            <legend>Pantallas actuales</legend>
            <p>
              Inicio → Identificación → Búsqueda → Verificación → Habitación →
              Entrega. La vista previa simula las transiciones; el dispositivo
              usa peticiones reales. La selección de etapas opcionales aún no
              está disponible.
            </p>
            <label>
              Espera (ms)
              <input
                type="number"
                min={15000}
                max={300000}
                value={theme.idleMs}
                onChange={(e) => update({ idleMs: Number(e.target.value) })}
              />
            </label>
            <label>
              Retorno (ms)
              <input
                type="number"
                min={3000}
                max={30000}
                value={theme.returnMs}
                onChange={(e) => update({ returnMs: Number(e.target.value) })}
              />
            </label>
          </fieldset>
          <fieldset
            disabled={mode !== "edit"}
            hidden={category !== "Contenido"}
          >
            <legend>Textos públicos</legend>
            <details open>
              <summary>Textos y traducciones · {lang}</summary>
              <label>
                Elemento de texto
                <select
                  value={contentKey}
                  onChange={(e) => setContentKey(e.target.value)}
                >
                  {TEXT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {textLabels[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Contenido
                <input
                  value={texts[contentKey]}
                  onChange={(e) =>
                    update({
                      texts: {
                        ...theme.texts,
                        [lang]: { ...texts, [contentKey]: e.target.value },
                      },
                    })
                  }
                />
              </label>
            </details>
          </fieldset>
          <details>
            <summary>Ajustes técnicos y asignación de habitaciones</summary>
            <label>
              Habitación:gancho · un par por línea
              <textarea
                rows={6}
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
              />
            </label>
          </details>
        </div>
        <div className="hb-stage">
          <div className="hb-actions">
            <select
              aria-label="Idioma de vista previa"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
            {[
              "home",
              "form",
              "waiting",
              "verify",
              "authorized",
              "delivery",
              "done",
              "error",
            ].map((s) => (
              <button
                key={s}
                onClick={() => {
                  setScreen(s);
                  setSelection(undefined);
                  setValue("");
                }}
              >
                {
                  {
                    home: "Inicio",
                    form: "Identificación y teclado",
                    waiting: "Búsqueda",
                    verify: "Verificación",
                    authorized: "Habitación",
                    delivery: "Entrega",
                    done: "Final",
                    error: "Error",
                  }[s]
                }
              </button>
            ))}
          </div>
          <div className="hb-canvas-wrap">
            <canvas
              ref={canvas}
              width={800}
              height={480}
              onClick={click}
              onPointerDown={startHold}
              onPointerUp={stopHold}
              onPointerCancel={stopHold}
              onPointerLeave={stopHold}
              aria-label="Vista previa interactiva CrowPanel 800 por 480"
            />
            {mode === "edit" && selection && (
              <div
                className="hb-selected"
                aria-hidden="true"
                style={{
                  left: selection.rect[0] / 8 + "%",
                  top: selection.rect[1] / 4.8 + "%",
                  width: selection.rect[2] / 8 + "%",
                  height: selection.rect[3] / 4.8 + "%",
                }}
              />
            )}
          </div>
          <p>
            Vista previa interactiva: no consulta reservas ni acciona llaves.
            Posiciones a 800 × 480. Fuente y anchos derivados del firmware. El
            antialiasing y la codificación del QR pueden variar respecto a LVGL;
            validar el aspecto final en el panel. SVG y fondos a pantalla
            completa no admitidos por el presupuesto de memoria.
          </p>
          <details>
            <summary>Versiones publicadas y diagnóstico</summary>
            <h2>Versiones</h2>
            {data.versions.map((v) => (
              <div key={v.id} className="hb-version">
                <span>
                  {new Date(v.createdAt).toLocaleString()} · {v.id}
                </span>
                <button
                  disabled={busy}
                  onClick={() => {
                    setTheme(upgradeTheme(v.manifest.theme));
                    if (v.manifest.roomMapping)
                      setMapping(
                        v.manifest.roomMapping
                          .map((r) => `${r.room}:${r.hook}`)
                          .join("\n"),
                      );
                    setMessage(
                      "Versión anterior cargada para revisar; publica para restaurarla",
                    );
                  }}
                >
                  Revisar / restaurar
                </button>
              </div>
            ))}
            <h2>Diagnóstico JSON</h2>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setTraces(
                    await hookboxRequest(
                      "diagnostics" +
                        (selectedDevice
                          ? "?deviceId=" + encodeURIComponent(selectedDevice)
                          : ""),
                    ),
                  ),
                )
              }
            >
              Actualizar mensajes
            </button>
            <p>
              Últimos 50 intercambios. Credenciales, apellidos, reservas y
              pruebas de identidad se ocultan antes de guardarse.
            </p>
            {traces.map((t) => (
              <details key={t.id}>
                <summary>
                  {t.createdAt} · {t.path} · HTTP {t.status}
                </summary>
                <strong>Petición</strong>
                <pre>{JSON.stringify(t.request, null, 2)}</pre>
                <strong>Respuesta</strong>
                <pre>{JSON.stringify(t.response, null, 2)}</pre>
              </details>
            ))}
            <h2>Aplicación por dispositivo</h2>
            {data.devices.map((d) => (
              <article key={d.id}>
                <strong>{d.name}</strong>
                <p>
                  Deseada: {d.uiDesiredVersion || "—"}
                  <br />
                  Aplicada: {d.uiAppliedVersion || "—"}
                  <br />
                  {d.uiRejectedReason}
                </p>
                <details>
                  <summary>Eventos recientes</summary>
                  {d.events?.map((event) => (
                    <p key={event.id}>
                      <strong>
                        {new Date(event.createdAt).toLocaleString()} ·{" "}
                        {event.type}
                      </strong>
                      <br />
                      {event.detail}
                    </p>
                  ))}
                </details>
              </article>
            ))}
          </details>
        </div>
      </div>
    </section>
  );
}

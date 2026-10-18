import { useEffect, useRef, useState } from "react";
import {
  defaultTheme,
  validateTheme,
  LANGUAGES,
  TEXT_KEYS,
  GEOMETRY as G,
  type Theme,
} from "../../../shared/hookbox/contract.mjs";
import { hookboxRequest, hookboxAsset } from "../../services/backendApi";
import "./hookbox.css";
type Version = { id: string; createdAt: string; manifest: { theme: Theme } };
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
    events?: {id:string;type:string;detail:string|null;createdAt:string}[];
  }[];
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
export function HookboxDesignPage() {
  const [data, setData] = useState<Editor>(),
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
  const texts = theme.texts[lang];
  useEffect(() => {
    void document.fonts
      .load("500 20px Montserrat")
      .then(() => setFontsReady(1));
  }, []);
  async function load() {
    const d = await hookboxRequest<Editor>("editor");
    setData(d);
    setTheme(d.hotel.draft);
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
    const color = theme.colors;
    ctx.fillStyle = color.background;
    ctx.fillRect(0, 0, 800, 480);
    const label = (
      s: string,
      x: number,
      y: number,
      size = 20,
      foreground = color.text,
    ) => {
      ctx.fillStyle = foreground;
      ctx.font = `500 ${size}px Montserrat, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(s, x, y);
    };
    const rect = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(x, y, w, h);
    };
    const button = (s: string, x: number, y: number, w: number, h = 48) => {
      rect(x, y, w, h, color.primary);
      label(s, x + 12, y + 14, 20, color.buttonText);
    };
    label(theme.hotelName, G.brand[0], G.brand[1], 28, color.primary);
    label(texts.welcome, G.title[0], G.title[1], 40);
    if (theme.logo && images[theme.logo]) {
      const im = new Image();
      im.onload = () => {
        if (!cancelled) ctx.drawImage(im, G.logo[0], G.logo[1]);
      };
      im.src = images[theme.logo];
    }
    if (screen === "home") {
      const x = theme.template === "classic-left" ? G.cardLeftX : G.card[0];
      rect(x, G.card[1], G.card[2], G.card[3], color.surface);
      label(
        texts.subtitle,
        x + G.subtitleOffset[0],
        G.card[1] + G.subtitleOffset[1],
      );
      button(
        texts.id,
        x + G.homeButtons[0],
        G.homeButtons[2],
        G.homeButtons[3],
        G.homeButtons[5],
      );
      button(
        texts.surname,
        x + G.homeButtons[1],
        G.homeButtons[2],
        G.homeButtons[4],
        G.homeButtons[5],
      );
      if (theme.qr.enabled) {
        const qx =
          theme.template === "classic-left" ? G.qrLeft[0] : G.qrRight[0];
        void import("qrcode").then(async (QR) => {
          const c = document.createElement("canvas");
          await QR.toCanvas(c, theme.qr.data, {
            width: theme.qr.size,
            margin: 2,
            errorCorrectionLevel: "M",
          });
          if (!cancelled) ctx.drawImage(c, qx, G.qrRight[1]);
        });
      }
      if (theme.background && images[theme.background]) {
        const im = new Image();
        im.onload = () => {
          if (!cancelled) ctx.drawImage(im, 24, 376);
        };
        im.src = images[theme.background];
      }
      LANGUAGES.forEach((l, i) =>
        button(
          l,
          G.languages[0] + i * G.languages[2],
          G.languages[1],
          G.languages[3],
          G.languages[4],
        ),
      );
      button(
        "Service",
        ...([G.service[0], G.service[1], G.service[2], G.service[3]] as [
          number,
          number,
          number,
          number,
        ]),
      );
    } else if (screen === "form" || screen === "verify") {
      if (screen === "form") {
        button(texts.id, ...(G.id as [number, number, number, number]));
        button(
          texts.surname,
          ...(G.surname as [number, number, number, number]),
        );
      } else label(texts.verificationHelp, 24, 152);
      rect(G.input[0], G.input[1], G.input[2], G.input[3], color.surface);
      label(
        (screen === "verify" ? "*".repeat(value.length) : value) ||
          (screen === "verify"
            ? ""
            : texts[method === "id" ? "placeholderId" : "placeholderSurname"]),
        36,
        216,
      );
      button(
        screen === "verify" ? texts.verify : texts.search,
        ...(G.submit as [number, number, number, number]),
      );
      keys.forEach((row, r) =>
        (accents && r === 3
          ? accents === 1
            ? G.accentKeys
            : G.symbolKeys
          : [...row]
        ).forEach((k, i) =>
          button(
            shift && k !== "ß" ? k.toLocaleUpperCase() : k,
            G.keyboard[0] + i * G.keyboard[2],
            G.keyboard[1] + r * G.keyboard[3],
            G.keyboard[4],
            G.keyboard[5],
          ),
        ),
      );
      button("Space", G.space[0], G.footerY, G.space[1], 38);
      button("Shift", G.shift[0], G.footerY, G.shift[1], 38);
      button("äéñ", G.accents[0], G.footerY, G.accents[1], 38);
      button("Delete", G.delete[0], G.footerY, G.delete[1], 38);
      button(texts.home, G.home[0], G.footerY, G.home[1], 38);
    } else {
      rect(24, 160, 752, 204, color.surface);
      label(texts.room + " 101 (1/2)", 48, 184, 28);
      label(texts[screen === "delivery" ? "delivery" : "done"], 48, 250, 28);
      label("MOCK · " + texts.confirm, 48, 310);
      button(texts.home, 24, 390, 240);
    }
    return () => {
      cancelled = true;
    };
  }, [
    theme,
    lang,
    screen,
    method,
    value,
    images,
    texts,
    shift,
    accents,
    fontsReady,
  ]);
  function click(e: React.MouseEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect(),
      x = ((e.clientX - r.left) * 800) / r.width,
      y = ((e.clientY - r.top) * 480) / r.height;
    if (screen === "home" && y >= G.languages[1] && x >= G.languages[0]) {
      const l = LANGUAGES[Math.floor((x - G.languages[0]) / G.languages[2])];
      if (l) setLang(l);
    } else if (screen === "home" && y >= 264 && y <= 320) {
      const base = theme.template === "classic-left" ? 276 : 24;
      if (x >= base + 20 && x < base + 476) {
        setMethod(x < base + 254 ? "id" : "surname");
        setValue("");
        setScreen("form");
      }
    } else if (screen === "form" || screen === "verify") {
      if (y >= 152 && y < 196 && screen === "form") {
        setMethod(x < 274 ? "id" : "surname");
        setValue("");
      }
      if (y >= 204 && y < 252 && x >= 548 && value.trim()) {
        setValue("");
        setScreen(screen === "form" ? "verify" : "delivery");
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
    } else if (y >= 390) setScreen("home");
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
      <h1>Hookbox → Dispositivos → Diseño de pantalla</h1>
      <p>
        Hotel seleccionado en CICO. Publicación remota independiente del
        firmware.
      </p>
      <div className="hb-actions">
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
              const preset = defaultTheme("Gasthaus Steinbock");
              preset.logo = logo;
              preset.qr.data =
                "https://checkin.gasthaus-steinbock.ch/guest-login.php?lang=de";
              setTheme(preset);
              setMessage(
                "Tema piloto cargado como borrador; revisa y publica cuando esté listo",
              );
            })
          }
        >
          Cargar tema piloto Steinbock
        </button>
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
        <button disabled={busy} onClick={() => void run(load)}>
          Restaurar cambios
        </button>
        <button
          disabled={busy || !!validation}
          onClick={() =>
            void run(async () => {
              const h = await save();
              await hookboxRequest("publish", { revision: h.revision });
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
      <p role="status">{validation || message}</p>
      <div className="hb-grid">
        <div className="hb-fields">
          <label>
            Nombre del hotel
            <input
              maxLength={32}
              value={theme.hotelName}
              onChange={(e) => update({ hotelName: e.target.value })}
            />
          </label>
          <label>
            Plantilla
            <select
              value={theme.template}
              onChange={(e) => update({ template: e.target.value })}
            >
              <option value="classic-right">Clásica · QR derecha</option>
              <option value="classic-left">Clásica · QR izquierda</option>
            </select>
          </label>
          <label>
            Tipografía
            <select
              value={theme.font}
              onChange={(e) => update({ font: e.target.value })}
            >
              <option value="latin">Montserrat Latin (14/20/28/40)</option>
            </select>
          </label>
          {Object.entries(theme.colors).map(([key, val]) => (
            <label key={key}>
              {key}
              <input
                type="color"
                value={val}
                onChange={(e) =>
                  update({ colors: { ...theme.colors, [key]: e.target.value } })
                }
              />
            </label>
          ))}
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
            URL QR
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
          <details>
            <summary>Textos y traducciones · {lang}</summary>
            {TEXT_KEYS.map((k) => (
              <label key={k}>
                {k}
                <input
                  value={texts[k]}
                  onChange={(e) =>
                    update({
                      texts: {
                        ...theme.texts,
                        [lang]: { ...texts, [k]: e.target.value },
                      },
                    })
                  }
                />
              </label>
            ))}
          </details>
          <label>
            Habitación:gancho · un par por línea
            <textarea
              rows={6}
              value={mapping}
              onChange={(e) => setMapping(e.target.value)}
            />
          </label>
        </div>
        <div>
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
            {["home", "form", "verify", "delivery", "done"].map((s) => (
              <button
                key={s}
                onClick={() => {
                  setScreen(s);
                  setValue("");
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <canvas
            ref={canvas}
            width={800}
            height={480}
            onClick={click}
            aria-label="Vista previa interactiva CrowPanel 800 por 480"
          />
          <p>
            Vista previa MOCK: no consulta reservas ni acciona llaves.
            Posiciones a 800 × 480. Fuente y anchos derivados del firmware. El
            antialiasing y la codificación del QR pueden variar respecto a LVGL;
            validar el aspecto final en el panel. SVG y fondos a pantalla
            completa no admitidos por el presupuesto de memoria.
          </p>
          <h2>Versiones</h2>
          {data.versions.map((v) => (
            <div key={v.id} className="hb-version">
              <span>
                {new Date(v.createdAt).toLocaleString()} · {v.id}
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  setTheme(v.manifest.theme);
                  setMessage(
                    "Versión anterior cargada para revisar; publica para restaurarla",
                  );
                }}
              >
                Revisar / restaurar
              </button>
            </div>
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
              <details><summary>Eventos recientes</summary>{d.events?.map(event=><p key={event.id}><strong>{new Date(event.createdAt).toLocaleString()} · {event.type}</strong><br/>{event.detail}</p>)}</details>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}


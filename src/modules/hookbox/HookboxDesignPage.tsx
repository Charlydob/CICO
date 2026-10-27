import { useEffect, useRef, useState } from "react";

import {
  defaultTheme,
  upgradeTheme,
  validateTheme,
  LANGUAGES,
  type Theme,
} from "../../../shared/hookbox/contract.mjs";

import { hookboxRequest, hookboxAsset } from "../../services/backendApi";

import { renderGuestPortal } from "./drawGuestPortal";

import "./hookbox.css";

type Editor = {
  hotel: {
    draft: Theme;
    revision: number;
    mapping: { room: string; hook: number }[];
  };
  devices: { id: string; name: string; uiAppliedVersion: string | null }[];
};

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

export function HookboxDesignPage({
  deviceId,
  showTechnical = false,
}: { deviceId?: string; showTechnical?: boolean } = {}) {
  const [selectedDevice, setSelectedDevice] = useState(deviceId || ""),
    [data, setData] = useState<Editor>(),
    [theme, setTheme] = useState(defaultTheme()),
    [lang, setLang] = useState("de"),
    [screen, setScreen] = useState("home"),
    [value, setValue] = useState(""),
    [message, setMessage] = useState(""),
    [images, setImages] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);

  const update = (patch: Partial<Theme>) =>
    setTheme((t) => ({ ...t, ...patch }));

  const load = async (id = selectedDevice) => {
    const d = await hookboxRequest<Editor>(
      "editor" + (id ? "?deviceId=" + id : ""),
    );
    setData(d);
    setTheme(upgradeTheme(d.hotel.draft));
    setLang(d.hotel.draft.defaultLanguage);
  };

  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, [selectedDevice]);

  useEffect(() => {
    for (const id of [theme.logo, theme.background])
      if (id && !images[id])
        void hookboxAsset(id)
          .then(rgbUrl)
          .then((url) => setImages((v) => ({ ...v, [id]: url })))
          .catch((e) => setMessage(e.message));
  }, [theme.logo, theme.background, images]);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    let active = true;
    if (ctx)
      renderGuestPortal(
        ctx,
        theme,
        {
          lang,
          screen,
          method: "pin",
          value,
          shift: false,
          accents: 0,
          images,
        },
        () => active,
      );
    return () => {
      active = false;
    };
  }, [theme, lang, screen, value, images]);

  useEffect(() => {
    if (screen === "home") return;
    const timer = setTimeout(
      () =>
        setScreen(
          screen === "waiting"
            ? "delivery"
            : screen === "delivery"
              ? "done"
              : "home",
        ),
      screen === "waiting"
        ? 600
        : screen === "delivery"
          ? 1500
          : theme.returnMs,
    );
    return () => clearTimeout(timer);
  }, [screen, theme.returnMs]);

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

  async function save() {
    validateTheme(theme);
    const hotel = await hookboxRequest<Editor["hotel"]>("draft", {
      deviceId: selectedDevice || undefined,
      revision: data!.hotel.revision,
      theme,
      mapping: data!.hotel.mapping,
    });
    setData((d) => ({ ...d!, hotel }));
    setMessage("Diseño guardado");
    return hotel;
  }

  async function upload(file: File, kind: "logo" | "background") {
    if (
      !["image/png", "image/jpeg"].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    )
      throw Error("Upload a PNG or JPG up to 4 MB. SVG is not supported.");

    const bitmap = await createImageBitmap(file);

    if (bitmap.width * bitmap.height > 16000000) {
      bitmap.close();

      throw Error("Image is too large.");
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

  function click(e: React.MouseEvent<HTMLCanvasElement>) {
    if (screen !== "home") return;
    const r = e.currentTarget.getBoundingClientRect(),
      x = ((e.clientX - r.left) * 800) / r.width,
      y = ((e.clientY - r.top) * 480) / r.height,
      kx = theme.qr.enabled ? (theme.qr.x < 400 ? 312 : 48) : 180;

    if (x < kx || x > kx + 440) return;

    if (y >= 396 && y <= 454) {
      if (value.length >= 4) {
        setScreen("waiting");
        setValue("");
      }
      return;
    }

    const row = Math.floor((y - 132) / 66),
      col = Math.floor((x - kx) / 150);
    if (
      row < 0 ||
      row > 3 ||
      col < 0 ||
      col > 2 ||
      y > 132 + row * 66 + 56 ||
      x > kx + col * 150 + 140
    )
      return;

    const key = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"][
      row * 3 + col
    ];
    setValue((v) =>
      key === "C" ? "" : key === "<" ? v.slice(0, -1) : (v + key).slice(0, 12),
    );
  }

  const keys = [
    "placeholderId",
    "search",
    "searching",
    "delivery",
    "done",
    "error",
  ];

  return (
    <section className="hb-editor">
      <h1>Pantalla PIN · 800 × 480</h1>
      {deviceId && (
        <a href={window.location.pathname.replace(/\/screen\/?$/, "")}>
          Volver al dispositivo
        </a>
      )}
      <p>
        Los diseños publicados se distribuyen automáticamente sin actualizar el
        firmware.
      </p>

      <label>
        Aplicar a{" "}
        <select
          value={selectedDevice}
          disabled={Boolean(deviceId)}
          onChange={(e) => setSelectedDevice(e.target.value)}
        >
          <option value="">Diseño del hotel</option>
          {data?.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      <div className="panel">
        <canvas
          ref={canvas}
          width={800}
          height={480}
          style={{
            width: "100%",
            maxWidth: 800,
            aspectRatio: "800/480",
            borderRadius: 0,
          }}
          onClick={click}
          aria-label="Vista previa interactiva del teclado PIN"
        />

        <p>Prueba visual simulada. Pulsa el teclado; no activa hardware.</p>
        <label>
          Vista{" "}
          <select
            aria-label="Vista"
            value={screen}
            onChange={(e) => setScreen(e.target.value)}
          >
            {[
              ["home", "Inicio PIN"],
              ["waiting", "Comprobando"],
              ["delivery", "Entregando llave"],
              ["done", "Éxito"],
              ["error", "Error"],
            ].map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="panel">
        <h2>Textos y colores</h2>
        <label>
          Nombre del hotel
          <input
            value={theme.hotelName}
            onChange={(e) => update({ hotelName: e.target.value })}
          />
        </label>
        <label>
          Idioma{" "}
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label>
          Idioma inicial{" "}
          <select
            value={theme.defaultLanguage}
            onChange={(e) => update({ defaultLanguage: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>

        {keys.map((k) => (
          <label key={k} style={{ display: "block" }}>
            {
              (
                {
                  placeholderId: "Campo PIN",
                  search: "Confirmación",
                  searching: "Comprobando",
                  delivery: "Entregando",
                  done: "Éxito",
                  error: "Error",
                } as Record<string, string>
              )[k]
            }
            <input
              value={theme.texts[lang][k]}
              onChange={(e) =>
                update({
                  texts: {
                    ...theme.texts,
                    [lang]: { ...theme.texts[lang], [k]: e.target.value },
                  },
                })
              }
            />
          </label>
        ))}

        {Object.entries(theme.colors).map(([k, v]) => (
          <label key={k}>
            {({background:'Fondo',surface:'Paneles',primary:'Botones',text:'Texto de avisos',buttonText:'Texto de botones',secondary:'Texto secundario',inputBackground:'Fondo del campo PIN',inputText:'Texto del PIN',inputBorder:'Borde del campo PIN'} as Record<string,string>)[k]||k}
            <input
              type="color"
              value={v}
              onChange={(e) =>
                update({ colors: { ...theme.colors, [k]: e.target.value } })
              }
            />
          </label>
        ))}
      </div>

      <div className="panel">
        <h2>QR y marca</h2>
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
          URL HTTPS o texto
          <input
            value={theme.qr.data}
            onChange={(e) =>
              update({ qr: { ...theme.qr, data: e.target.value } })
            }
          />
        </label>

        <label>
          Tamaño
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

        {(["x", "y", "margin"] as const).map((k) => (
          <label key={k}>
            {k === "x"
              ? "Posición horizontal"
              : k === "y"
                ? "Posición vertical"
                : "Margen blanco"}
            <input
              type="number"
              value={theme.qr[k]}
              onChange={(e) =>
                update({ qr: { ...theme.qr, [k]: Number(e.target.value) } })
              }
            />
          </label>
        ))}

        {(["logo", "background"] as const).map((kind) => (
          <label key={kind}>
            {kind === "logo" ? "Logotipo" : "Fondo"}
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
      </div>

      <button disabled={busy || !data} onClick={() => void run(save)}>
        Guardar borrador
      </button>
      <button
        disabled={busy || !data}
        onClick={() =>
          void run(async () => {
            const h = await save();
            await hookboxRequest("publish", {
              deviceId: selectedDevice || undefined,
              revision: h.revision,
            });
            setMessage("Publicado. Esperando confirmación de la pantalla.");
            await load();
          })
        }
      >
        Publicar en pantalla
      </button>

      {showTechnical && (
        <p>
          Las asignaciones habitación y gancho se administran en la ficha del
          dispositivo.
        </p>
      )}
      <p role="status">{message}</p>
    </section>
  );
}

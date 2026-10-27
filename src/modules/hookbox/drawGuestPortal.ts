import { type Theme } from "../../../shared/hookbox/contract.mjs";
import QRCode from "qrcode";
export function renderGuestPortal(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  state: {
    lang: string;
    screen: string;
    method: string;
    value: string;
    shift: boolean;
    accents: number;
    images: Record<string, string>;
  },
  alive: () => boolean,
) {
  const c = theme.colors,
    t = theme.texts[state.lang],
    kx = theme.qr.enabled ? (theme.qr.x < 400 ? 312 : 48) : 180;
  const box = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();
  };
  const text = (s: string, x: number, y: number, color = c.text) => {
    ctx.fillStyle = color;
    ctx.font = "500 20px Montserrat";
    ctx.textBaseline = "top";
    ctx.fillText(s, x, y);
  };
  const button = (s: string, x: number, y: number, w: number, h: number) => {
    box(x, y, w, h, c.primary);
    text(s, x + 12, y + (h - 20) / 2, c.buttonText);
  };
  const draw = () => {
    if (!alive()) return;
    ctx.fillStyle = c.background;
    ctx.fillRect(0, 0, 800, 480);
    const bg = loaded[theme.background || ""];
    if (bg) {
      const z = Math.min(800 / bg.width, 480 / bg.height);
      ctx.drawImage(bg, 0, 0, bg.width * z, bg.height * z);
    }
    const logo = loaded[theme.logo || ""];
    if (logo) {
      const z = Math.min(1, 72 / logo.width, 48 / logo.height);
      ctx.drawImage(logo, 16, 8, logo.width * z, logo.height * z);
    }
    if (state.screen === "home") {
      box(kx, 64, 440, 56, c.inputBackground);
      ctx.strokeStyle = c.inputBorder;
      ctx.strokeRect(kx, 64, 440, 56);
      text(
        state.value ? "*".repeat(state.value.length) : t.placeholderId,
        kx + 12,
        82,
        c.inputText,
      );
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].forEach(
        (key, i) =>
          button(
            key,
            kx + (i % 3) * 150,
            132 + Math.floor(i / 3) * 66,
            140,
            56,
          ),
      );
      button(t.search, kx, 396, 440, 58);
      if (theme.qr.enabled) {
        const q = theme.qr,
          m = q.margin;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(q.x - m, q.y - m, q.size + 2 * m, q.size + 2 * m);
        if (qrCanvas) ctx.drawImage(qrCanvas, q.x, q.y, q.size, q.size);
      }
    } else {
      text(
        t[
          state.screen === "waiting"
            ? "searching"
            : state.screen === "delivery"
              ? "delivery"
              : state.screen === "done"
                ? "done"
                : "error"
        ],
        48,
        220,
      );
    }
  };
  const loaded: Record<string, HTMLImageElement> = {};
  let qrCanvas: HTMLCanvasElement | undefined;
  for (const id of [theme.logo, theme.background])
    if (id && state.images[id]) {
      const img = new Image();
      img.onload = () => {
        loaded[id] = img;
        draw();
      };
      img.src = state.images[id];
    }
  if (theme.qr.enabled) {
    const canvas = document.createElement("canvas");
    void QRCode.toCanvas(canvas, theme.qr.data, {
      width: theme.qr.size,
      margin: 0,
      errorCorrectionLevel: "M",
    }).then(() => {
      qrCanvas = canvas;
      draw();
    });
  }
  draw();
}

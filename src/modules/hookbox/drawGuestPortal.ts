import {
  GEOMETRY as G,
  LANGUAGES,
  type Theme,
} from "../../../shared/hookbox/contract.mjs";
import flagData from "../../../shared/hookbox/flags.json";
export function drawFlag(
  ctx: CanvasRenderingContext2D,
  lang: string,
  x: number,
  y: number,
) {
  const rows = flagData.flags[lang as keyof typeof flagData.flags];
  rows.forEach((row, j) =>
    [...row].forEach((n, i) => {
      ctx.fillStyle = flagData.palette[Number(n)];
      ctx.fillRect(x + i, y + j, 1, 1);
    }),
  );
}
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
  const { lang, screen, method, value, shift, accents, images } = state,
    t = theme.texts[lang] || theme.texts[theme.defaultLanguage],
    c = theme.colors;
  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    r = 14,
    border?: string,
  ) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  const label = (
    text: string,
    x: number,
    y: number,
    size = 20,
    color = c.text,
  ) => {
    ctx.font = `500 ${size}px Montserrat`;
    ctx.textBaseline = "top";
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  const button = (
    text: string,
    x: number,
    y: number,
    w: number,
    h = 48,
    kind = "primary",
  ) => {
    box(
      x,
      y,
      w,
      h,
      kind === "field"
        ? c.inputBackground
        : kind === "surface"
          ? c.surface
          : c.primary,
      10,
      kind === "field" ? c.inputBorder : undefined,
    );
    label(
      text,
      x + 12,
      y + (h - 20) / 2,
      20,
      kind === "field"
        ? c.secondary
        : kind === "surface"
          ? c.text
          : c.buttonText,
    );
  };
  const asset = (
    id: string | null,
    x: number,
    y: number,
    maxW: number,
    maxH: number,
  ) => {
    if (!id || !images[id]) return;
    const im = new Image();
    im.onload = () => {
      if (alive()) {
        const scale = Math.min(1, maxW / im.width, maxH / im.height);
        ctx.drawImage(im, x, y, im.width * scale, im.height * scale);
      }
    };
    im.src = images[id];
  };
  ctx.clearRect(0, 0, 800, 480);
  ctx.fillStyle = c.background;
  ctx.fillRect(0, 0, 800, 480);
  asset(theme.logo, 24, 16, 72, 56);
  label(
    theme.hotelName,
    theme.logo ? 112 : G.brand[0],
    G.brand[1],
    28,
    c.primary,
  );
  ctx.fillStyle = c.inputBorder;
  ctx.fillRect(24, 82, 752, 1);
  LANGUAGES.forEach((l, i) => {
    const x = G.languages[0] + i * G.languages[2],
      y = G.languages[1];
    box(x, y, 44, 40, c.surface, 10, l === lang ? c.primary : undefined);
    drawFlag(ctx, l, x + 6, y + 9);
  });
  label(t.welcome, ...(G.title as [number, number]), 40, c.primary);
  if (screen === "home") {
    label(t.subtitle, 24, 153, 20, c.secondary);
    asset(theme.background, 568, 96, 160, 96);
    for (const [index, key] of ["id", "surname"].entries()) {
      const card = index ? G.homeSurname : G.homeId,
        input = index ? G.homeSecondInput : G.homeInput,
        submit = index ? G.homeSecondSubmit : G.homeSubmit;
      box(
        ...(card as [number, number, number, number]),
        c.surface,
        16,
        c.inputBorder,
      );
      label(t[key], card[0] + 20, card[1] + 16, 20, c.primary);
      button(
        t[index ? "placeholderSurname" : "placeholderId"],
        ...(input as [number, number, number, number]),
        "field",
      );
      button(t.search, ...(submit as [number, number, number, number]));
    }
    if (theme.qr.enabled) {
      box(
        ...(G.qrCard as [number, number, number, number]),
        c.surface,
        16,
        c.inputBorder,
      );
      const size = theme.qr.size,
        qx = G.qrCard[0] + (G.qrCard[2] - size) / 2,
        qy = 216 + (192 - size) / 2;
      box(qx - 8, qy - 8, size + 16, size + 16, "#ffffff", 10);
      void import("qrcode").then(async (QR) => {
        const image = document.createElement("canvas");
        await QR.toCanvas(image, theme.qr.data, {
          width: size,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        if (alive()) ctx.drawImage(image, qx, qy);
      });
      label(t.qrHelp, G.qrHelp[0], G.qrHelp[1], 14, c.secondary);
    }
  } else if (screen === "form" || screen === "verify") {
    if (screen === "form") {
      button(
        t.id,
        ...(G.id as [number, number, number, number]),
        method === "id" ? "primary" : "surface",
      );
      button(
        t.surname,
        ...(G.surname as [number, number, number, number]),
        method === "surname" ? "primary" : "surface",
      );
    } else label(t.verificationHelp, 24, 152, 20, c.secondary);
    box(
      ...(G.input as [number, number, number, number]),
      c.inputBackground,
      10,
      c.inputBorder,
    );
    label(
      (screen === "verify" ? "*".repeat(value.length) : value) ||
        (screen === "verify"
          ? ""
          : t[method === "id" ? "placeholderId" : "placeholderSurname"]),
      36,
      216,
      20,
      value ? c.inputText : c.secondary,
    );
    button(
      t[screen === "verify" ? "verify" : "search"],
      ...(G.submit as [number, number, number, number]),
    );
    G.rows.forEach((row: string, r: number) =>
      (accents && r === 3
        ? accents === 1
          ? G.accentKeys
          : G.symbolKeys
        : [...row]
      ).forEach((k: string, i: number) =>
        button(
          shift && k !== "ß" ? k.toLocaleUpperCase() : k,
          G.keyboard[0] + i * G.keyboard[2],
          G.keyboard[1] + r * G.keyboard[3],
          G.keyboard[4],
          G.keyboard[5],
          "surface",
        ),
      ),
    );
    button(t.space, G.space[0], G.footerY, G.space[1], 38, "surface");
    button(t.shift, G.shift[0], G.footerY, G.shift[1], 38, "surface");
    button("äéñ", G.accents[0], G.footerY, G.accents[1], 38, "surface");
    button(t.delete, G.delete[0], G.footerY, G.delete[1], 38, "surface");
    button(t.home, G.home[0], G.footerY, G.home[1], 38);
  } else if (screen === "service") {
    box(120, 180, 560, 240, c.surface, 16, c.inputBorder);
    label("PIN", 160, 204, 28, c.primary);
    box(160, 252, 480, 52, c.inputBackground, 10, c.inputBorder);
    label("•••", 184, 264, 20, c.inputText);
    button(t.home, 160, 336, 240, 48);
  } else {
    box(24, 176, 752, 204, c.surface, 16, c.inputBorder);
    if (["authorized", "delivery", "done"].includes(screen)) {
      label(t.room + " 101 (1/2)", 48, 194, 28, c.primary);
      label(
        t[
          screen === "authorized"
            ? "confirm"
            : screen === "delivery"
              ? "delivery"
              : "done"
        ],
        48,
        252,
        28,
      );
      if (screen === "authorized") button(t.confirm, 48, 310, 650, 48);
    } else
      label(
        t[screen === "waiting" ? "searching" : "error"],
        48,
        232,
        28,
        c.text,
      );
    if (screen !== "delivery" && screen !== "waiting")
      button(t.home, 24, 400, 240, 48);
  }
}

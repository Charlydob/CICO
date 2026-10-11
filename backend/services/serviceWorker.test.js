import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadServiceWorker({ showNotification, windows = [], openWindow = async () => undefined }) {
  const listeners = {};
  const self = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    skipWaiting: async () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow,
    },
    registration: {
      showNotification,
      setAppBadge: async () => undefined,
      clearAppBadge: async () => undefined,
    },
    location: { origin: "https://hotelapp.example" },
  };
  const script = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(script, { self, URL, console });
  return listeners;
}

test("service worker shows checkout push while no PWA window is open", async () => {
  const shown = [];
  const listeners = await loadServiceWorker({
    showNotification: async (title, options) => shown.push({ title, options }),
  });
  let completion;
  listeners.push({
    data: { json: () => ({
      title: "Checkout",
      body: "Demo Hotel · Habitación 204",
      url: "/t/demo-hotel/?housekeepingRoom=204",
      roomId: "room-204",
    }) },
    waitUntil(promise) { completion = promise; },
  });
  await completion;

  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.body, "Demo Hotel · Habitación 204");
  assert.equal(shown[0].options.data.url, "/t/demo-hotel/?housekeepingRoom=204");
});

test("service worker reports display errors to open windows without rejecting push", async () => {
  const messages = [];
  const listeners = await loadServiceWorker({
    showNotification: async () => { throw new Error("display failed"); },
    windows: [{ postMessage: (message) => messages.push(message) }],
  });
  let completion;
  listeners.push({
    data: { json: () => ({ title: "Checkout" }) },
    waitUntil(promise) { completion = promise; },
  });
  await assert.doesNotReject(() => completion);
  assert.equal(messages.some((message) => message.type === "HOTELAPP_NOTIFICATION_DISPLAY_ERROR"), true);
});

test("notification click opens the checkout room when the PWA is closed", async () => {
  const opened = [];
  const listeners = await loadServiceWorker({
    showNotification: async () => undefined,
    openWindow: async (url) => opened.push(url),
  });
  let completion;
  listeners.notificationclick({
    notification: {
      data: { url: "/t/demo-hotel/?housekeepingRoom=204" },
      close() {},
    },
    waitUntil(promise) { completion = promise; },
  });
  await completion;
  assert.deepEqual(opened, ["https://hotelapp.example/t/demo-hotel/?housekeepingRoom=204"]);
});

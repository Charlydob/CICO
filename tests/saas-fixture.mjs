import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "../backend/databaseClient.js";
import {
  hashPassword,
  createLoginSession,
  sessionCookieHeader,
} from "../backend/services/sessionService.js";
import {
  createRoom,
  registerCheckout,
  setTodayCheckoutRooms,
  createKeyIdentifier,
} from "../backend/services/checkoutService.js";
import { applyHousekeepingAction } from "../backend/services/housekeepingService.js";
import { createHookboxService } from "../backend/hookbox/service.js";
if (
  !String(process.env.DATABASE_URL).includes(
    "127.0.0.1:55439/hookbox_test_final",
  )
)
  throw Error("Local QA database required");
const db = createDatabaseClient(),
  a = randomUUID(),
  b = randomUUID(),
  state = {
    tenants: [],
    users: {},
    rooms: {},
    devices: {},
    keys: {},
    evidence: {},
  };
for (const [id, name] of [
  [a, "QA Alpine House"],
  [b, "QA Private Hotel B"],
]) {
  const slug = "saas-qa-" + id.slice(0, 8);
  await db.setRecord("tenants", id, {
    name,
    slug,
    active: true,
    basicInfo: { displayName: name, timezone: "Europe/Zurich" },
  });
  for (const module of ["checkout", "parking"])
    await db.setTenantModule(id, module, id === a || module === "checkout");
  state.tenants.push({ id, name, slug });
}
const passwordHash = await hashPassword("Local-QA-password-only-123");
for (const [label, role, hotel] of [
  ["superadmin", "platform_admin", a],
  ["owner", "tenant_admin", a],
  ["manager", "manager", a],
  ["staff", "staff", a],
  ["other", "tenant_admin", b],
]) {
  const id = randomUUID(),
    email = label + "-" + id.slice(0, 8) + "@example.test";
  await db.setRecord("users", id, {
    email,
    displayName: "QA " + label,
    passwordHash,
    active: true,
    ...(label === "superadmin" ? { globalRole: "platform_admin" } : {}),
  });
  if (label !== "superadmin")
    await db.setRecord("memberships", randomUUID(), {
      tenantId: hotel,
      userId: id,
      role,
    });
  const login = await createLoginSession(db, { id });
  state.users[label] = {
    id,
    email,
    hotel,
    sessionId: login.id,
    cookie: sessionCookieHeader(login.id, login.expiresAt).split(";")[0],
  };
}
for (const [hotel, number, status] of [
  [a, "101", "occupied"],
  [a, "102", "occupied"],
  [a, "103", "occupied"],
  [a, "104", "unknown"],
  [b, "201", "occupied"],
]) {
  const room = await createRoom(db, hotel, {
    number,
    status,
    accessCode: hotel === a ? "A-1234" : "B-private-code",
  });
  state.rooms[number] = room.id;
}
await setTodayCheckoutRooms(
  db,
  a,
  [state.rooms["101"]],
  new Date().toISOString().slice(0, 10),
);
const actor = { user: { id: state.users.owner.id }, role: "tenant_admin" };
for (const number of ["102", "103"]) {
  const checkout = await registerCheckout(db, a, state.rooms[number], "manual");
  if (number === "103")
    for (const action of ["bed_done", "cleaning_done", "complete"])
      await applyHousekeepingAction(db, {
        tenantId: a,
        eventId: checkout.event.id,
        actor,
        action,
      });
}
state.keys.a = await createKeyIdentifier(db, a, {
  roomId: state.rooms["101"],
  type: "qr",
  label: "Room 101",
});
state.keys.b = await createKeyIdentifier(db, b, {
  roomId: state.rooms["201"],
  type: "qr",
  label: "Private room 201",
});
const hb = createHookboxService(db.prisma, async () => {
  throw Error("Provider not configured");
});
for (const hotel of [a, b]) {
  const device = await db.prisma.device.create({
    data: {
      deviceId: "qa-panel-" + randomUUID(),
      tenantId: hotel,
      name: hotel === a ? "Reception display" : "Private B display",
      hardwareModel: "CROWPANEL_7_V3",
      status: "OFFLINE",
      tokenHash: "test-only",
    },
  });
  state.devices[hotel === a ? "a" : "b"] = device.id;
  const e = await hb.editor(hotel, device.id);
  await hb.draft(hotel, {
    deviceId: device.id,
    revision: e.hotel.revision,
    theme: e.hotel.draft,
    mapping: [{ room: hotel === a ? "101" : "201", hook: 7 }],
  });
  await hb.publish(
    hotel,
    { deviceId: device.id, revision: 1 },
    state.users.superadmin.id,
  );
}
const checkoutBox = await db.prisma.device.create({
  data: {
    deviceId: "qa-panel-" + randomUUID(),
    tenantId: b,
    name: "CheckoutBox QA",
    hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1",
    status: "OFFLINE",
    tokenHash: "test-only",
  },
});
state.devices.checkoutbox = checkoutBox.id;
const directory = fileURLToPath(
  new URL("../../saas-evidence/snapshots", import.meta.url),
);
await mkdir(directory, { recursive: true });
for (const [hotel, label] of [
  [a, "a"],
  [b, "b"],
]) {
  const filename = "qa-" + label + "-" + randomUUID() + ".jpg",
    file = path.join(directory, filename);
  await writeFile(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmh8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await db.prisma.detection.create({
    data: {
      tenantId: hotel,
      plate: label === "a" ? "ALPINE101" : "PRIVATEB201",
      camera: "QA entrance",
      detectedAt: new Date(),
      associationStatus: "unmatched",
      parkingStatus: "unknown",
      reviewStatus: "pending",
      localSnapshotPath: file,
      metadata: { privateInfrastructure: "not-for-customer" },
    },
  });
  state.evidence[label] = filename;
}
await writeFile(
  new URL("../../private-saas-qa.json", import.meta.url),
  JSON.stringify(state),
  { mode: 0o600, flag: "wx" },
);
console.log("LOCAL_MULTIHOTEL_QA_FIXTURES_READY");
await db.disconnect();

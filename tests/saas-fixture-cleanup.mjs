import { readFile, unlink } from "node:fs/promises";
import { createDatabaseClient } from "../backend/databaseClient.js";
if (
  !String(process.env.DATABASE_URL).includes(
    "127.0.0.1:55439/hookbox_test_final",
  )
)
  throw Error("Local QA database required");
const stateFile = new URL("../../private-saas-qa.json", import.meta.url),
  state = JSON.parse(await readFile(stateFile)),
  db = createDatabaseClient();
try {
  const hotels = state.tenants.map((t) => t.id),
    users = Object.values(state.users).map((u) => u.id),
    devices = Object.values(state.devices);
  for (const id of hotels) {
    const hotel = await db.prisma.tenant.findUnique({ where: { id } });
    if (hotel && !hotel.slug.startsWith("saas-qa-"))
      throw Error("Refusing to remove an unrelated hotel");
  }
  await db.prisma.device.deleteMany({
    where: { id: { in: devices }, deviceId: { startsWith: "qa-panel-" } },
  });
  await db.prisma.tenant.deleteMany({
    where: { id: { in: hotels }, slug: { startsWith: "saas-qa-" } },
  });
  await db.prisma.user.deleteMany({
    where: { id: { in: users }, email: { endsWith: "@example.test" } },
  });
  const ids = [...hotels, ...users, ...devices];
  await db.prisma.diagnostic.deleteMany({
    where: {
      OR: ids.flatMap((id) => [
        { key: { contains: id } },
        { value: { path: ["tenantId"], equals: id } },
      ]),
    },
  });
  for (const filename of Object.values(state.evidence)) {
    if (!/^qa-[ab]-[a-f0-9-]+\.jpg$/.test(filename))
      throw Error("Unexpected test evidence filename");
    await unlink(
      new URL("../../saas-evidence/snapshots/" + filename, import.meta.url),
    ).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  await unlink(stateFile);
  console.log("LOCAL_SAAS_QA_FIXTURES_AND_SESSIONS_REMOVED");
} finally {
  await db.disconnect();
}

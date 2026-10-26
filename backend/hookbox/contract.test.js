import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  defaultTheme,upgradeTheme,
  validateTheme,
  validateQuery,
  validateMapping,
  authorizedRooms,
  LANGUAGES,
} from "../../shared/hookbox/contract.mjs";
import { mockProvider } from "./mockProvider.js";
import { createCheckinProvider } from "./provider.js";
test("all four languages, only known geometry, font and bounded translated copy", () => {
  const t = defaultTheme();
  assert.equal(validateTheme(t).width, 800);
  for (const l of LANGUAGES) {
    assert.ok(t.texts[l].surname);
    validateQuery({
      schemaVersion: 1,
      operationId: randomUUID(),
      language: l,
      method: "surname",
      value: "Müller",
    });
  }
  for (const patch of [
    { width: 480 },
    { font: "html" },
    { idleMs: 0 },
    { solenoidMs: 9000 },
    { texts: { de: { welcome: "😀" } } },
    { logo: "../../unsafe" },
    { qr: { enabled: true, data: "javascript:alert(1)", size: 160 } },
  ])
    assert.throws(() => validateTheme({ ...t, ...patch }));
});
test("lookup rejects invalid, ambiguous identifiers never authorize key release", () => {
  for (const method of ["id", "surname"])
    assert.equal(
      validateQuery({
        schemaVersion: 1,
        operationId: randomUUID(),
        language: "de",
        method,
        value: "A12",
      }).method,
      method,
    );
  assert.throws(() =>
    validateQuery({
      schemaVersion: 1,
      operationId: "bad",
      language: "de",
      method: "id",
      value: "x",
    }),
  );
  for (const status of ["AMBIGUOUS", "INSUFFICIENT", "NOT_FOUND", "CHALLENGE"])
    assert.throws(() =>
      authorizedRooms({ schemaVersion: 1, status, rooms: ["101"] }),
    );
});
test("identity AND all delivery conditions are required; rooms and hooks are unique", () => {
  const p = {
    schemaVersion: 1,
    authorized: true,
    identityVerified: true,
    conditionsSatisfied: true,
    reservationId: "stay-1",
    rooms: ["101", "102"],
  };
  assert.equal(authorizedRooms(p).length, 2);
  for (const k of ["authorized", "identityVerified", "conditionsSatisfied"])
    assert.throws(() => authorizedRooms({ ...p, [k]: false }));
  assert.throws(() => authorizedRooms({ ...p, rooms: ["101", "101"] }));
  assert.throws(() =>
    validateMapping([
      { room: "101", hook: 1 },
      { room: "102", hook: 1 },
    ]),
  );
  assert.throws(() => validateMapping([{ room: "101", hook: 26 }]));
  assert.equal(
    validateMapping(
      Array.from({ length: 25 }, (_, i) => ({
        room: String(i + 1),
        hook: i + 1,
      })),
    ).length,
    25,
  );
});
test("proposed provider protocol: authenticated mock, two rooms, wrong proof, hotel isolation, fail closed", async () => {
  await assert.rejects(createCheckinProvider("{")("hotel", "lookup", {}), {statusCode:503});
  process.env.NODE_ENV = "test";
  const tenantId = randomUUID(),
    token = "test-provider-token",
    server = mockProvider({ tenantId, token });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = createCheckinProvider(
      JSON.stringify({
        [tenantId]: {
          url: `http://127.0.0.1:${server.address().port}`,
          token,
          mock: true,
        },
      }),
    );
    const op = randomUUID();
    const q = await p(tenantId, "lookup", {
      operationId: op,
      method: "id",
      value: "MULTI",
    });
    assert.equal(q.status, "CHALLENGE");
    await assert.rejects(
      p(tenantId, "verify", { challengeId: q.challengeId, proof: "bad" }),
    );
    const v = await p(tenantId, "verify", {
      challengeId: q.challengeId,
      proof: "123456",
    });
    assert.deepEqual(authorizedRooms(v), ["101", "102"]);
    assert.equal(v.mock, true);
    await assert.rejects(p(randomUUID(), "lookup", {}));
    process.env.NODE_ENV = "production";
    await assert.rejects(p(tenantId, "lookup", {}));
  } finally {
    process.env.NODE_ENV = "test";
    await new Promise((r) => server.close(r));
  }
});

test('guest portal migration preserves translations and configurable colors, never mixes defaults',()=>{
  const legacy=defaultTheme('Example');legacy.template='classic-left';delete legacy.colors.inputText;
  for(const language of LANGUAGES)delete legacy.texts[language].space;
  const upgraded=upgradeTheme(legacy);assert.equal(upgraded.template,'guest-portal');assert.equal(upgraded.texts.fr.space,'Espace');assert.equal(upgraded.texts.de.space,'Leerzeichen');validateTheme(upgraded);
  for(const data of ['JaVaScRiPt:alert(1)','DaTa:text/html,x','http://example.com'])assert.throws(()=>validateTheme({...upgraded,qr:{...upgraded.qr,data}}));
  assert.equal(validateTheme({...upgraded,qr:{...upgraded.qr,data:'reservation portal'}}).qr.data,'reservation portal');
});

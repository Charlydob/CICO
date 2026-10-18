import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { HookboxDeviceSimulator } from "./deviceSimulator.mjs";
import { defaultTheme } from "../../shared/hookbox/contract.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
test("file-backed protocol simulator: theme download, resources, reboot, outage, rollback, corrupt resource rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hookbox-sim-")),
    bytes = Buffer.from([0, 0]),
    asset = hash(bytes);
  let corrupt = false,
    outage = false;
  const ack = [];
  let manifest;
  const publish = () => {
    const theme = defaultTheme("Simulator Hotel");
    theme.logo = asset;
    manifest = {
      schemaVersion: 1,
      version: randomUUID(),
      tenantId: "fixture",
      theme,
      assets: [
        {
          id: asset,
          sha256: asset,
          bytes: 2,
          width: 1,
          height: 1,
          kind: "logo",
          format: "rgb565le",
        },
      ],
    };
  };
  publish();
  const server = createServer(async (req, res) => {
    if (
      req.headers.authorization !== "Bearer test" ||
      req.headers["x-device-id"] !== "test-panel"
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (outage) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (req.url.endsWith("/design"))
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          version: manifest.version,
          sha256: hash(JSON.stringify(manifest)),
          manifest: JSON.stringify(manifest),
        }),
      );
    else if (req.url.includes("/assets/"))
      res.end(corrupt ? Buffer.from([1, 1]) : bytes);
    else {
      let data = "";
      for await (const c of req) data += c;
      ack.push(JSON.parse(data));
      res.end('{"ok":true}');
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const options = {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      deviceId: "test-panel",
      token: "test",
      directory: root,
      allowLocalHttp: true,
    },
    sim = new HookboxDeviceSimulator(options);
  try {
    const a = await sim.sync();
    assert.equal(
      (await new HookboxDeviceSimulator(options).boot()).version,
      a.version,
    );
    outage = true;
    await assert.rejects(sim.sync());
    assert.equal((await sim.boot()).version, a.version);
    outage = false;
    publish();
    await assert.rejects(
      sim.sync({
        apply: async () => {
          throw Error("UI failure");
        },
      }),
    );
    assert.equal((await sim.boot()).version, a.version);
    assert.equal(ack.at(-1).status, "rejected");
    corrupt = true;
    publish();
    await assert.rejects(sim.sync());
    assert.equal((await sim.boot()).version, a.version);
    corrupt = false;
    const b = await sim.sync();
    assert.notEqual(b.version, a.version);
    const state = JSON.parse(
      await readFile(path.join(root, "state.json"), "utf8"),
    );
    state.pending = true;
    await writeFile(path.join(root, "state.json"), JSON.stringify(state));
    assert.equal(
      (await new HookboxDeviceSimulator(options).boot()).version,
      a.version,
    );
  } finally {
    await new Promise((r) => server.close(r));
    if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), "hookbox-sim-"))) throw Error("Unexpected test cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});


// Desktop protocol simulator. This module has no hardware driver and cannot energize outputs.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateTheme, LIMITS } from "../../shared/hookbox/contract.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export class HookboxDeviceSimulator {
  constructor({ baseUrl, deviceId, token, directory, allowLocalHttp = false }) {
    const u = new URL(baseUrl);
    if (
      u.protocol !== "https:" &&
      !(allowLocalHttp && u.protocol === "http:" && u.hostname === "127.0.0.1")
    )
      throw Error("HTTPS required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.deviceId = deviceId;
    this.token = token;
    this.directory = directory;
  }
  async request(endpoint, body, binary = false) {
    const r = await fetch(this.baseUrl + "/api/device/v1/hookbox/" + endpoint, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        "X-Device-Id": this.deviceId,
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify({ schemaVersion: 1, ...body }) : undefined,
    });
    if (!r.ok) throw Error("CICO HTTP " + r.status);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > (binary ? 32768 : 32768))
      throw Error("Response too large");
    return binary ? bytes : JSON.parse(bytes.toString());
  }
  async atomic(file, data) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      path.join(this.directory, file + ".tmp"),
      JSON.stringify(data),
    );
    await rename(
      path.join(this.directory, file + ".tmp"),
      path.join(this.directory, file),
    );
  }
  async read(file) {
    return JSON.parse(await readFile(path.join(this.directory, file), "utf8"));
  }
  async boot() {
    let state;
    try {
      state = await this.read("state.json");
    } catch {
      return null;
    }
    if (state.pending) {
      state = { active: state.previous, previous: null, pending: false };
      await this.atomic("state.json", state);
    }
    if (!state.active) return null;
    const e = await this.read(state.active + "/manifest.json");
    if (sha(e.raw) !== e.sha256) throw Error("Stored manifest integrity");
    const d = JSON.parse(e.raw);
    validateTheme(d.theme);
    for (const a of d.assets) {
      const bytes = await readFile(
        path.join(this.directory, state.active, a.kind + ".bin"),
      );
      if (bytes.length !== a.bytes || sha(bytes) !== a.sha256)
        throw Error("Stored asset integrity");
    }
    return d;
  }
  async sync({ apply = async () => {} } = {}) {
    const envelope = await this.request("design");
    if (!envelope.version) return null;
    if (
      typeof envelope.manifest !== "string" ||
      sha(envelope.manifest) !== envelope.sha256
    )
      throw Error("Manifest integrity");
    const d = JSON.parse(envelope.manifest);
    validateTheme(d.theme);
    if (
      d.schemaVersion !== 1 ||
      d.version !== envelope.version ||
      !/^[-a-f0-9]{36}$/.test(d.version) ||
      !Array.isArray(d.assets) ||
      d.assets.length > 2
    )
      throw Error("Manifest schema");
    let total = 0;
    const target = "theme-" + d.version;
    await mkdir(path.join(this.directory, target), { recursive: true });
    try {
      for (const a of d.assets) {
        if (
          !["logo", "background"].includes(a.kind) ||
          a.format !== "rgb565le" ||
          !/^[-a-f0-9]{64}$/.test(a.id) ||
          a.bytes !== a.width * a.height * 2 ||
          a.bytes > LIMITS.assetBytes
        )
          throw Error("Unsupported resource");
        total += a.bytes;
        if (total > LIMITS.totalAssetBytes) throw Error("Asset budget");
        const bytes = await this.request("assets/" + a.id, undefined, true);
        if (bytes.length !== a.bytes || sha(bytes) !== a.sha256)
          throw Error("Asset integrity");
        await writeFile(
          path.join(this.directory, target, a.kind + ".bin"),
          bytes,
        );
      }
      await writeFile(
        path.join(this.directory, target, "manifest.json"),
        JSON.stringify({ raw: envelope.manifest, sha256: envelope.sha256 }),
      );
      let old = {};
      try {
        old = await this.read("state.json");
      } catch {}
      // Same validated configuration only needs an ACK, not another commit.
      if (old.active !== target) {
        await this.atomic("state.json", {
          active: target,
          previous: old.active || null,
          pending: true,
        });
        try {
          await apply(d);
        } catch (error) {
          await this.atomic("state.json", {
            active: old.active || null,
            previous: null,
            pending: false,
          });
          throw error;
        }
        await this.atomic("state.json", {
          active: target,
          previous: old.active || null,
          pending: false,
        });
      }
      await this.request("design/ack", {
        version: d.version,
        sha256: envelope.sha256,
        status: "applied",
      });
      return d;
    } catch (e) {
      await this.request("design/ack", {
        version: d.version,
        sha256: envelope.sha256,
        status: "rejected",
        reason: e.message,
      }).catch(() => {});
      throw e;
    }
  }
  async checkin({
    method,
    value,
    proof,
    language = "de",
    onPulse = async () => {},
  }) {
    try {
      const old = await this.read("operation.json");
      if (old.status !== "COMPLETE")
        throw Error("Previous operation uncertain; no automatic retry");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const operationId = randomUUID();
    let op = await this.request("lookup", {
      operationId,
      method,
      value,
      language,
    });
    if (op.status !== "CHALLENGE") return op;
    op = await this.request("verify", { operationId, proof });
    if (op.status !== "AUTHORIZED" || op.mock !== true)
      throw Error("MOCK authorization required");
    await this.atomic("operation.json", {
      operationId,
      status: "START_PENDING",
      index: 0,
    });
    op = await this.request("release/start", { operationId });
    if (op.status !== "RELEASING" || op.results.length)
      throw Error("Release already started");
    for (let index = 0; index < op.rooms.length; index++) {
      await this.atomic("operation.json", {
        operationId,
        index,
        status: "MOCK_PULSE_PENDING",
      });
      await onPulse({ ...op.rooms[index], index });
      await this.request("release/result", {
        operationId,
        index,
        result: "MOCK_ACTIVATION",
        physicallyConfirmed: false,
        mock: true,
      });
    }
    op = await this.request("complete", { operationId });
    if (op.status !== "COMPLETE") throw Error("Incomplete");
    await this.atomic("operation.json", { operationId, status: "COMPLETE" });
    return op;
  }
}
if (process.argv.includes("--run")) {
  const c = JSON.parse(
    await readFile(process.env.HOOKBOX_SIM_IDENTITY_FILE, "utf8"),
  );
  const sim = new HookboxDeviceSimulator({
    baseUrl: c.base_url,
    deviceId: c.device_id,
    token: c.token,
    directory: process.env.HOOKBOX_SIM_STATE_DIR || "work/hookbox-sim-state",
  });
  await sim.boot();
  console.log("MOCK theme:", (await sim.sync())?.version || "none");
}

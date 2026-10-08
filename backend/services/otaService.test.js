import assert from "node:assert/strict";
import test from "node:test";
import { createOtaService } from "./otaService.js";

const deviceId = "11111111-1111-4111-8111-111111111111";

function serviceHarness(devicePatch = {}) {
  const state = {
    device: {
      id: deviceId,
      deviceId: "checkoutbox-test",
      hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1",
      tokenHash: "token-hash",
      credentialRevokedAt: null,
      servoDiagnosticState: "INACTIVE",
      servoDiagnosticRemaining: 0,
      desiredConfig: null,
      configVersion: "1",
      ...devicePatch,
    },
    commands: [],
  };
  const matches = (command, where) =>
    (!where.deviceId || command.deviceId === where.deviceId) &&
    (!where.type || command.type === where.type) &&
    (!where.status || command.status === where.status) &&
    (!where.expiresAt?.gt ||
      new Date(command.expiresAt).getTime() > new Date(where.expiresAt.gt).getTime());
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    device: {
      findUnique: async ({ where }) => where.id === state.device.id ? state.device : null,
      update: async ({ data }) => Object.assign(state.device, data),
    },
    otaRequest: { findFirst: async () => null },
    deviceCommand: {
      count: async ({ where }) => state.commands.filter((command) => matches(command, where)).length,
      create: async ({ data }) => {
        const command = {
          id: `22222222-2222-4222-8222-${String(state.commands.length + 1).padStart(12, "0")}`,
          status: "PENDING",
          createdAt: new Date(),
          ...data,
        };
        state.commands.push(command);
        return command;
      },
      findUnique: async ({ where }) => state.commands.find(({ id }) => id === where.id) || null,
      update: async ({ where, data }) => {
        const command = state.commands.find(({ id }) => id === where.id);
        Object.assign(command, data);
        return command;
      },
      updateMany: async ({ where, data }) => {
        const commands = state.commands.filter((command) => matches(command, where));
        commands.forEach((command) => Object.assign(command, data));
        return { count: commands.length };
      },
    },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  return {
    state,
    service: createOtaService(prisma, {}),
    authenticatedDevice: { id: deviceId, tokenHash: "token-hash" },
  };
}

test("diagnostic ACK closes the heartbeat gap and blocks every servo movement command", async () => {
  const { service, state, authenticatedDevice } = serviceHarness();
  const start = await service.command(deviceId, "SERVO_DIAG_START", { durationSec: 60 }, "admin");
  await service.acknowledgeCommand(authenticatedDevice, {
    command_id: start.id,
    ok: true,
    result: "started_60s_no_position_feedback",
  });
  assert.equal(state.device.servoDiagnosticState, "RUNNING");
  assert.equal(state.device.servoDiagnosticRemaining, 60);
  for (const type of [
    "OPEN_TRAP", "CLOSE_TRAP", "CYCLE_TRAP", "SET_SERVO_CONFIG",
    "SERVO_DIAG_START", "SERVO_RAW_PWM_TEST", "SERVO_RAW_PIN25_TEST",
  ]) {
    const payload = type === "SERVO_DIAG_START"
      ? { durationSec: 10 }
      : type === "SET_SERVO_CONFIG"
        ? { closedAngle: 10, openAngle: 90, holdMs: 1500 }
        : {};
    await assert.rejects(
      service.command(deviceId, type, payload, "admin"),
      (error) => error.statusCode === 409,
    );
  }
  await assert.rejects(
    service.updateConfiguration(deviceId, { closedAngle: 10, openAngle: 90, holdMs: 1500 }),
    (error) => error.statusCode === 409,
  );
});

test("priority stop preserves cancellation when the superseded command ACK arrives late", async () => {
  const { service, state, authenticatedDevice } = serviceHarness();
  const movement = await service.command(deviceId, "OPEN_TRAP", {}, "admin");
  const stop = await service.command(deviceId, "SERVO_DIAG_STOP", {}, "admin");
  assert.equal(state.commands.find(({ id }) => id === movement.id).status, "CANCELLED");
  const lateAck = await service.acknowledgeCommand(authenticatedDevice, {
    command_id: movement.id,
    ok: true,
    result: "open_commanded_no_position_feedback",
  });
  assert.equal(lateAck.status, "CANCELLED");
  assert.equal(state.commands.find(({ id }) => id === movement.id).status, "CANCELLED");
  await service.acknowledgeCommand(authenticatedDevice, {
    command_id: stop.id,
    ok: true,
    result: "stopped_safe_position_commanded_no_position_feedback",
  });
  assert.equal(state.device.servoDiagnosticState, "COMPLETED");
});

test("diagnostic start waits for pending configuration synchronization", async () => {
  const desiredConfig = { version: "2", closedAngle: 10, openAngle: 90, holdMs: 1500 };
  const { service } = serviceHarness({ desiredConfig });
  await assert.rejects(
    service.command(deviceId, "SERVO_DIAG_START", { durationSec: 30 }, "admin"),
    (error) => error.statusCode === 409,
  );
});

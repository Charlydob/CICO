import assert from "node:assert/strict";
import test from "node:test";
import { createOtaService } from "./otaService.js";

const deviceId = "11111111-1111-4111-8111-111111111111";

function serviceHarness(devicePatch = {}, activeUpdate = null) {
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
      currentFirmwareVersion: "1.2.0",
      currentBuildId: "old-build",
      tenantId: null,
      ...devicePatch,
    },
    commands: [],
    activeUpdate,
    otaEvents: [],
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
    otaRequest: {
      findFirst: async () => state.activeUpdate,
      update: async ({ data }) => Object.assign(state.activeUpdate, data),
    },
    otaEvent: {
      create: async ({ data }) => state.otaEvents.push(data),
    },
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

test("servo preview keeps only the newest pending discrete position", async () => {
  const { service, state } = serviceHarness();
  const first = await service.command(deviceId, "TEST_SERVO_POSITION", { angle: 30 }, "admin");
  const second = await service.command(deviceId, "TEST_SERVO_POSITION", { angle: 70 }, "admin");
  assert.equal(state.commands.find(({ id }) => id === first.id).status, "CANCELLED");
  assert.equal(state.commands.find(({ id }) => id === first.id).result.value, "superseded_by_newer_preview_position");
  assert.equal(state.commands.find(({ id }) => id === second.id).status, "PENDING");
  assert.deepEqual(state.commands.find(({ id }) => id === second.id).payload, { angle: 70 });
});

test("heartbeat closes a rebooting OTA as failed when installed version matches but build does not", async () => {
  const active = {
    id: "33333333-3333-4333-8333-333333333333",
    status: "REBOOTING",
    progress: 100,
    release: { version: "1.3.0", buildId: "20261010.cico-manager-v2" },
  };
  const { service, state } = serviceHarness({}, active);
  const result = await service.heartbeat(state.device, {
    device_id: state.device.deviceId,
    hardware_model: state.device.hardwareModel,
    firmware_version: "1.3.0",
    build_id: "20261010.cico-managed-v2",
    config_version: "1",
    uptime: 30,
    rssi: -52,
    local_ip: "192.168.1.20",
    free_heap: 100000,
    psram: 0,
    last_reset_reason: "SW_CPU_RESET",
    last_ota_result: "REBOOTING",
  });
  assert.equal(result.ota_reconciliation_error, "INSTALLED_BUILD_MISMATCH");
  assert.equal(state.activeUpdate.status, "FAILED");
  assert.equal(state.activeUpdate.resultCode, "INSTALLED_BUILD_MISMATCH");
  assert.equal(state.device.currentFirmwareVersion, "1.3.0");
  assert.equal(state.device.currentBuildId, "20261010.cico-managed-v2");
  assert.equal(state.device.targetFirmwareVersion, null);
  assert.equal(state.otaEvents[0].status, "FAILED");
});

test("RFID ingestion records chronological reads, one honest return and suppresses repeated returns", async () => {
  const device={
    id:deviceId,deviceId:"checkoutbox-test",name:"Checkout recepción",
    tenantId:"44444444-4444-4444-8444-444444444444",
    hardwareModel:"ESP32_DEVKIT_CHECKOUT_V1",desiredConfig:{duplicateRfidMs:1500},
  };
  const state={
    key:{id:"55555555-5555-4555-8555-555555555555",deviceId,uid:"AABBCCDD",name:"Llave 204",room:"Habitación 204",authorized:true,active:true},
    readings:[],checkouts:[],deviceEvents:[],
  };
  const tx={
    deviceEvent:{
      createMany:async({data})=>state.deviceEvents.push(...data),
      findFirst:async()=>null,
      deleteMany:async()=>({count:0}),
    },
    deviceRfidKey:{
      upsert:async({where,create,update})=>{
        if(state.key.uid===where.deviceId_uid.uid) return Object.assign(state.key,update);
        state.key={id:"66666666-6666-4666-8666-666666666666",...create,name:"",room:"",authorized:false,active:true};
        return state.key;
      },
    },
    deviceRfidReading:{
      findFirst:async({where})=>state.readings.filter((item)=>item.uid===where.uid).at(-1)||null,
      create:async({data})=>{const reading={id:`reading-${state.readings.length+1}`,createdAt:new Date(),checkoutEventId:null,...data};state.readings.push(reading);return reading;},
      update:async({where,data})=>Object.assign(state.readings.find((item)=>item.id===where.id),data),
    },
    tenant:{findUnique:async()=>({id:device.tenantId,name:"Hotel Prueba",slug:"hotel-prueba"})},
    room:{findFirst:async()=>({id:"77777777-7777-4777-8777-777777777777",number:"204",name:"Habitación 204"})},
    checkoutEvent:{create:async({data})=>{const event={id:`checkout-${state.checkouts.length+1}`,timestamp:new Date(),...data};state.checkouts.push(event);return event;}},
    device:{update:async()=>device},
  };
  const prisma={$transaction:async(callback)=>callback(tx)};
  const service=createOtaService(prisma,{});
  await service.ingestEvents(device,{events:[
    {type:"RFID_READ",detail:"AABBCCDD authorized",uptime_ms:1000},
    {type:"RFID_READ",detail:"AABBCCDD authorized",uptime_ms:1050},
  ]});
  assert.equal(state.readings.length,2);
  assert.equal(state.readings[0].eventType,"RETURN_RECORDED");
  assert.equal(state.readings[0].result,"AUTHORIZED_RETURN_RECORDED");
  assert.equal(state.readings[1].eventType,"RFID_READ");
  assert.equal(state.readings[1].result,"DUPLICATE_SUPPRESSED");
  assert.equal(state.checkouts.length,1);
  assert.equal(state.checkouts[0].status,"recorded_unconfirmed");
  assert.equal(state.checkouts[0].metadata.physicalConfirmation,false);
  assert.equal(state.readings[0].hotelName,"Hotel Prueba");
  assert.equal(state.readings[0].room,"Habitación 204");
});

test("device hotel reassignment is audited without rewriting historical RFID context", async () => {
  const oldTenant="88888888-8888-4888-8888-888888888888";
  const newTenant="99999999-9999-4999-8999-999999999999";
  const admin="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const device={id:deviceId,deviceId:"checkoutbox-test",tenantId:oldTenant,tokenHash:null,credentialRevokedAt:null};
  const readings=[{id:"read-old",deviceId,tenantId:oldTenant,hotelName:"Hotel Antiguo",room:"204"}];
  const assignments=[];
  const tenants={
    [oldTenant]:{id:oldTenant,name:"Hotel Antiguo"},
    [newTenant]:{id:newTenant,name:"Hotel Nuevo"},
  };
  const tx={
    $queryRaw:async()=>[{locked:1}],
    tenant:{findUnique:async({where})=>tenants[where.id]||null},
    device:{
      findUnique:async()=>device,
      update:async({data})=>Object.assign(device,data,{tenant:tenants[data.tenantId]||null}),
    },
    deviceTenantAssignment:{create:async({data})=>assignments.push(data)},
  };
  const prisma={$transaction:async(callback)=>callback(tx)};
  const service=createOtaService(prisma,{});
  const result=await service.assignTenant(deviceId,newTenant,admin);
  assert.equal(result.tenantId,newTenant);
  assert.equal(assignments.length,1);
  assert.equal(assignments[0].fromTenantName,"Hotel Antiguo");
  assert.equal(assignments[0].toTenantName,"Hotel Nuevo");
  assert.equal(readings[0].tenantId,oldTenant);
  assert.equal(readings[0].hotelName,"Hotel Antiguo");
});

test("RFID reading history applies filters and bounded pagination", async () => {
  let captured;
  const prisma={deviceRfidReading:{
    findMany:async(input)=>{captured=input;return [{id:"page-item"}];},
    count:async()=>51,
  }};
  const result=await createOtaService(prisma,{}).listRfidReadings(deviceId,{
    page:"2",pageSize:"25",room:"204",result:"AUTHORIZED_RETURN_RECORDED",
    from:"2026-10-01T00:00:00.000Z",to:"2026-10-31T23:59:59.999Z",
  });
  assert.equal(captured.skip,25);
  assert.equal(captured.take,25);
  assert.equal(captured.where.room.contains,"204");
  assert.equal(captured.where.result,"AUTHORIZED_RETURN_RECORDED");
  assert.ok(captured.where.createdAt.gte instanceof Date);
  assert.equal(result.pages,3);
});

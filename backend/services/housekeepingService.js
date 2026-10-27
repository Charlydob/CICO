import { registerCheckout, updateRoom } from "./checkoutService.js";
import {
  canManageHousekeeping,
  requireHousekeepingPermission,
} from "./housekeepingPermissions.js";
import {
  sendAssignmentPush,
  sendRoomCompletedPush,
} from "./webPushService.js";
import { displayNameForMembership } from "./userDisplayService.js";

const PENDING_STATUSES = new Set(["ready_for_cleaning", "cleaning"]);
const ALLOWED_ACTIONS = new Set(["claim", "bed_done", "cleaning_done", "complete", "assign", "undo_bed", "undo_cleaning", "reopen", "undo_checkout"]);
const MEMBER_ROLES = new Set(["tenant_admin", "manager", "staff"]);

function now() {
  return new Date().toISOString();
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function publicTenant(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
  };
}

function localDate(value, timezone) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function latestEventByRoom(events) {
  const byRoom = new Map();

  for (const event of [...events].filter(e=>e.status!=="reversed").sort(
    (left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
  )) {
    if (!byRoom.has(event.roomId)) {
      byRoom.set(event.roomId, event);
    }
  }

  return byRoom;
}

function housekeepingMetadata(event) {
  return event?.metadata?.housekeeping && typeof event.metadata.housekeeping === "object"
    ? event.metadata.housekeeping
    : {};
}

async function actorHydrator(database, tenantId) {
  const [users, memberships] = await Promise.all([
    database.listRecords("users"),
    database.listRecords("memberships"),
  ]);

  return (id, includeRole = false) => {
    const user = users.find((candidate) => candidate.id === id);
    if (!user) {
      return null;
    }

    const membership = memberships.find(
      (candidate) => candidate.tenantId === tenantId && candidate.userId === id,
    );
    const role = user.globalRole === "platform_admin" ? "platform_admin" : membership?.role || null;

    return {
      userId: user.id,
      displayName: displayNameForMembership(user, membership),
      ...(user.telegramUsername ? { telegramUsername: user.telegramUsername } : {}),
      ...(includeRole ? { role } : {}),
    };
  };
}

async function hydratedHousekeeping(database, event) {
  const housekeeping = housekeepingMetadata(event);
  const actor = await actorHydrator(database, event.tenantId);

  return {
    assignedTo: actor(housekeeping.assignedToUserId, true),
    assignedAt: housekeeping.assignedAt || null,
    bedDoneBy: actor(housekeeping.bedDoneByUserId),
    bedDoneAt: housekeeping.bedDoneAt || null,
    cleaningDoneBy: actor(housekeeping.cleaningDoneByUserId),
    cleaningDoneAt: housekeeping.cleaningDoneAt || null,
    completedBy: actor(housekeeping.completedByUserId),
    completedAt: housekeeping.completedAt || null,
  };
}

function publicRoom(room, { includeAccessCode = false } = {}) {
  return {
    roomId: room.id,
    roomNumber: room.number,
    roomName: room.name || "",
    status: room.status,
    ...(includeAccessCode ? { accessCode: room.accessCode ?? null } : {}),
  };
}

async function getTenant(database, tenantId) {
  const tenant = await database.getRecord("tenants", tenantId);

  if (!tenant || tenant.active === false) {
    const error = new Error("Tenant not found.");
    error.statusCode = 404;
    throw error;
  }

  return tenant;
}

async function getEventRoomContext(database, tenantId, eventId) {
  const event = await database.getTenantRecord("checkoutEvents", tenantId, eventId);

  if (!event) {
    const error = new Error("Checkout event not found.");
    error.statusCode = 404;
    throw error;
  }

  const room = await database.getTenantRecord("rooms", tenantId, event.roomId);

  if (!room || room.active === false || room.deletedAt) {
    const error = new Error("Room not found.");
    error.statusCode = 404;
    throw error;
  }

  return { event, room };
}

async function resolveEventId(database, tenant, input = {}) {
  const eventId = cleanString(input.eventId || input.checkoutEventId);
  if (eventId) {
    return eventId;
  }

  const roomNumber = cleanString(input.roomNumber);
  if (!roomNumber) {
    return "";
  }

  const timezone = tenant.basicInfo?.timezone || "UTC";
  const today = localDate(new Date(), timezone);
  const rooms = await database.listTenantRecords("rooms", tenant.id);
  const room = rooms.find(
    (candidate) =>
      candidate.active !== false &&
      !candidate.deletedAt &&
      String(candidate.number).toLowerCase() === roomNumber.toLowerCase(),
  );

  if (!room) {
    return "";
  }

  const candidates = (await database.listTenantRecords("checkoutEvents", tenant.id))
    .filter((event) => event.roomId === room.id && localDate(event.timestamp, timezone) === today)
    .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));

  return candidates[0]?.id || "";
}

export async function getHousekeepingBoard(database, tenantId, options = {}) {
  const tenant = await getTenant(database, tenantId);
  const [rooms, events] = await Promise.all([
    database.listTenantRecords("rooms", tenant.id),
    database.listTenantRecords("checkoutEvents", tenant.id),
  ]);
  const timezone = tenant.basicInfo?.timezone || "UTC";
  const today = localDate(new Date(), timezone);
  const todayEvents = events.filter((event) => localDate(event.timestamp, timezone) === today);
  const eventByRoom = latestEventByRoom(events);
  const activeRooms = rooms
    .filter((room) => room.active !== false && !room.deletedAt)
    .sort((left, right) => String(left.number).localeCompare(String(right.number)));
  const pendingRows = activeRooms
    .filter((room) => PENDING_STATUSES.has(room.status) && eventByRoom.has(room.id))
    .map((room) => {
      const event = eventByRoom.get(room.id);
      const includeItemAccessCode =
        options.includeItemAccessCodes ?? options.includeAccessCodes !== false;

      return {
        ...publicRoom(room, { includeAccessCode: includeItemAccessCode }),
        eventId: event?.id || "",
        checkoutTimestamp: event?.timestamp || room.lastCheckoutAt || "",
        source: event?.source || room.lastCheckoutSource || "",
      };
    });
  const items = await Promise.all(
    pendingRows.map(async (item) => ({
      ...item,
      housekeeping: await hydratedHousekeeping(database, eventByRoom.get(item.roomId)),
    })),
  );
  const checkoutToday = activeRooms
    .filter((room) => String(room.checkoutDueDate || "").slice(0, 10) === today)
    .map((room) => ({
      ...publicRoom(room, {
        includeAccessCode:
          options.includeCheckoutAccessCodes ?? options.includeAccessCodes !== false,
      }),
      room: room.number,
      checkoutDueDate: String(room.checkoutDueDate).slice(0, 10),
      source: room.checkoutDueSource || "manual",
    }));
  const doneRows = activeRooms
    .filter(
      (room) =>
        room.status === "ready" &&
        room.lastCleanedAt &&
        localDate(room.lastCleanedAt, timezone) === today &&
        eventByRoom.has(room.id),
    )
    .map((room) => {
      const event = eventByRoom.get(room.id);
      return {
        ...publicRoom(room, {
          includeAccessCode:
            options.includeDoneAccessCodes ?? options.includeAccessCodes !== false,
        }),
        eventId: event.id,
        checkoutTimestamp: event.timestamp,
        cleanedTimestamp: room.lastCleanedAt,
        source: event.source,
      };
    });
  const done = await Promise.all(
    doneRows.map(async (item) => ({
      ...item,
      housekeeping: await hydratedHousekeeping(database, eventByRoom.get(item.roomId)),
    })),
  );
  const staleTelegramMessages = events
    .filter(
      (event) =>
        event.telegramMessageId &&
        event.telegramChatId &&
        !event.telegramMessageDeletedAt &&
        localDate(event.timestamp, timezone) < today,
    )
    .map((event) => ({
      eventId: event.id,
      messageId: event.telegramMessageId,
      chatId: event.telegramChatId,
      checkoutDate: localDate(event.timestamp, timezone),
    }));

  return {
    tenant: publicTenant(tenant),
    updatedAt: now(),
    date: today,
    timezone,
    checkoutToday,
    pendingCleaning: items,
    done,
    staleTelegramMessages,
    items,
    allRooms: activeRooms.map((room) => publicRoom(room, { includeAccessCode: false })),
    summary: {
      checkoutToday: checkoutToday.length,
      waiting: items.filter((item) => item.status === "ready_for_cleaning").length,
      cleaning: items.filter((item) => item.status === "cleaning").length,
      done: done.length,
      total: items.length,
    },
  };
}

export async function getHousekeepingStaff(database, tenantId, options = {}) {
  await getTenant(database, tenantId);
  const [users, memberships] = await Promise.all([
    database.listRecords("users"),
    database.listRecords("memberships"),
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const members = memberships
    .filter((membership) => membership.tenantId === tenantId && MEMBER_ROLES.has(membership.role))
    .map((membership) => ({ membership, user: usersById.get(membership.userId) }))
    .filter(({ user }) => user && user.active !== false)
    .map(({ membership, user }) => ({
      userId: user.id,
      displayName: displayNameForMembership(user, membership),
      email: user.email,
      telegramUsername: cleanString(user.telegramUsername).replace(/^@/, ""),
      telegramLinked: Boolean(cleanString(user.telegramUserId)),
      role: membership.role,
    }));

  if (options.includePlatformAdmins) {
    for (const user of users.filter(
      (candidate) => candidate.active !== false && candidate.globalRole === "platform_admin",
    )) {
      if (!members.some((member) => member.userId === user.id)) {
        members.push({
          userId: user.id,
          displayName: displayNameForMembership(user),
          email: user.email,
          telegramUsername: cleanString(user.telegramUsername).replace(/^@/, ""),
          telegramLinked: Boolean(cleanString(user.telegramUserId)),
          role: "platform_admin",
        });
      }
    }
  }

  return { success: true, tenantId, members };
}

export async function resolveAssignmentTargetByUserId(database, tenantId, userId,allowPlatformAdmin=false) {
  const cleanUserId = cleanString(userId);
  if (!cleanUserId) {
    return undefined;
  }

  const user = await database.getRecord("users", cleanUserId);
  if (!user || user.active === false) {
    const error = new Error("Assignment target not found in this tenant.");
    error.statusCode = 400;
    throw error;
  }

  if (allowPlatformAdmin&&user.globalRole === "platform_admin") {
    return { user, role: "platform_admin" };
  }

  const membership = (await database.listRecords("memberships")).find(
    (candidate) => candidate.tenantId === tenantId && candidate.userId === cleanUserId,
  );

  if (!membership || !MEMBER_ROLES.has(membership.role)) {
    const error = new Error("Assignment target not found in this tenant.");
    error.statusCode = 400;
    throw error;
  }

  return { user, membership, role: membership.role };
}

export async function applyHousekeepingAction(database, input = {}) {
  if(database.withRoomLock&&!input._locked){
    const tenant=await getTenant(database,input.tenantId),eventId=await resolveEventId(database,tenant,input);
    const context=await getEventRoomContext(database,input.tenantId,eventId);
    const result=await database.withRoomLock(input.tenantId,context.room.id,tx=>applyHousekeepingAction(tx,{...input,eventId,_locked:true}));
    if(!result.duplicate&&input.action==="complete")void sendRoomCompletedPush(database,{tenant,room:result.room,event:result.event,actorUser:input.actor.user}).catch(()=>{});
    if(!result.duplicate&&input.action==="assign")void sendAssignmentPush(database,{tenant,room:result.room,event:result.event,assignedUserId:input.assignmentTargetUserId||input.assignedToUserId}).catch(()=>{});
    return result;
  }
  const tenant = await getTenant(database, input.tenantId);
  const action = cleanString(input.action || input.type).toLowerCase();
  const actor = input.actor;

  if (!ALLOWED_ACTIONS.has(action) || !actor?.user?.id || !actor.role) {
    const error = new Error("Invalid housekeeping action.");
    error.statusCode = 400;
    throw error;
  }

  requireHousekeepingPermission(actor.role, action === "assign" ? "manage" : "use");
  const eventId = await resolveEventId(database, tenant, input);
  if (!eventId) {
    const error = new Error("An active checkout event is required.");
    error.statusCode = 404;
    throw error;
  }

  const { event, room } = await getEventRoomContext(database, tenant.id, eventId);
  const timestamp = now();
  const housekeeping = { ...housekeepingMetadata(event) };
  let assignedUserId = "";

  const manage=canManageHousekeeping(actor.role),error=(message,status=409)=>{throw Object.assign(Error(message),{statusCode:status})};
  if(event.status==='reversed'&&action!=='undo_checkout')error('This checkout was reversed. Refresh the board before making changes.');
  if(event.status!=='reversed'){
    const latest=(await database.listTenantRecords('checkoutEvents',tenant.id)).filter(e=>e.roomId===room.id&&e.status!=='reversed').sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0];
    if(latest?.id!==event.id)error('A newer checkout exists. Refresh the board before making changes.');
    if(room.status==='occupied')error('A new stay is active. This checkout can no longer be changed.');
  }
  if(action.startsWith('undo_')||action==='reopen'){
    if(action==='undo_checkout'||action==='reopen'||housekeeping.completedAt){if(!manage)error('Manager access is required for this correction.',403);if(!input.confirmed)error('Confirm this correction before continuing.');}
    if(!manage&&housekeeping.assignedToUserId&&housekeeping.assignedToUserId!==actor.user.id)error('Room belongs to another employee.',403);
    const latest=(await database.listTenantRecords('checkoutEvents',tenant.id)).filter(e=>e.roomId===room.id&&e.status!=='reversed').sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0];
    if(event.status==='reversed')return {success:true,duplicate:true,action,event,room,board:await getHousekeepingBoard(database,tenant.id)};
    if(latest?.id!==event.id)error('A newer checkout exists; this correction is no longer available.');
    if(housekeeping.completedAt||action==='undo_checkout'){
      const cycles=(await database.listTenantRecords('occupancyCycles',tenant.id)).filter(c=>c.roomId===room.id&&!c.consumedAt);
      if(cycles.some(c=>c.reservationCode||c.guestName))error('A new stay is active. Review the reservation before changing this checkout.');
      for(const cycle of cycles)await database.setRecord('occupancyCycles',cycle.id,{...cycle,consumedAt:timestamp,metadata:{...cycle.metadata,voidedByCorrection:actor.user.id}});
      delete housekeeping.completedAt;delete housekeeping.completedByUserId;
    }
    if(action==='undo_bed'){delete housekeeping.bedDoneAt;delete housekeeping.bedDoneByUserId;}
    if(action==='undo_cleaning'){delete housekeeping.cleaningDoneAt;delete housekeeping.cleaningDoneByUserId;}
    const audit=[...(event.metadata?.audit||[]),{action,actorId:actor.user.id,at:timestamp,reason:cleanString(input.reason)}];
    if(action==='undo_checkout'){
      const prior=event.metadata?.priorRoom||{},cycleId=event.occupancyCycleId;
      if(cycleId){const cycle=await database.getTenantRecord('occupancyCycles',tenant.id,cycleId);if(cycle)await database.setRecord('occupancyCycles',cycleId,{...cycle,consumedAt:null});}
      const correctedEvent=await database.setRecord('checkoutEvents',event.id,{...event,status:'reversed',occupancyCycleId:null,metadata:{...event.metadata,originalOccupancyCycleId:cycleId,reversedAt:timestamp,reversedBy:actor.user.id,audit}});
      const correctedRoom=await database.setRecord('rooms',room.id,{...room,status:prior.status||'occupied',lastCheckoutAt:prior.lastCheckoutAt||null,lastCheckoutSource:prior.lastCheckoutSource||null,checkoutDueDate:prior.checkoutDueDate||localDate(event.timestamp,tenant.basicInfo?.timezone),checkoutDueSource:prior.checkoutDueSource||'manual',lastCleanedAt:prior.lastCleanedAt||null,updatedAt:timestamp});
      return {success:true,action,event:correctedEvent,room:correctedRoom,board:await getHousekeepingBoard(database,tenant.id)};
    }
    const correctedEvent=await database.setRecord('checkoutEvents',event.id,{...event,metadata:{...event.metadata,housekeeping,audit}});
    const correctedRoom=await database.setRecord('rooms',room.id,{...room,status:'cleaning',lastCleanedAt:null,updatedAt:timestamp});
    return {success:true,action,event:correctedEvent,room:correctedRoom,board:await getHousekeepingBoard(database,tenant.id)};
  }
  if(housekeeping.completedAt&&action==='complete')return {success:true,duplicate:true,action,event,room,board:await getHousekeepingBoard(database,tenant.id)};
  if(housekeeping.completedAt&&['bed_done','cleaning_done'].includes(action))error('Reopen cleaning before changing its completed tasks.');

  if (action === "claim") {
    if (
      housekeeping.assignedToUserId &&
      housekeeping.assignedToUserId !== actor.user.id &&
      !canManageHousekeeping(actor.role)
    ) {
      const error = new Error("Room is already assigned to another staff member.");
      error.statusCode = 403;
      throw error;
    }
    if (housekeeping.assignedToUserId !== actor.user.id) {
      Object.assign(housekeeping, {
        assignedToUserId: actor.user.id,
        assignedByUserId: actor.user.id,
        assignedAt: timestamp,
      });
    }
  } else if (action === "assign") {
    const target = await resolveAssignmentTargetByUserId(
      database,
      tenant.id,
      input.assignmentTargetUserId || input.assignedToUserId,
      actor.role==='platform_admin',
    );
    if (!target) {
      const error = new Error("Assignment target is required.");
      error.statusCode = 400;
      throw error;
    }
    assignedUserId = target.user.id;
    Object.assign(housekeeping, {
      assignedToUserId: target.user.id,
      assignedByUserId: actor.user.id,
      assignedAt: timestamp,
    });
  } else if (action === "bed_done" && !housekeeping.bedDoneAt) {
    Object.assign(housekeeping, { bedDoneByUserId: actor.user.id, bedDoneAt: timestamp });
  } else if (action === "cleaning_done" && !housekeeping.cleaningDoneAt) {
    Object.assign(housekeeping, {
      cleaningDoneByUserId: actor.user.id,
      cleaningDoneAt: timestamp,
    });
  } else if (action === "complete") {
    if(!housekeeping.bedDoneAt||!housekeeping.cleaningDoneAt)error('Complete both bed and cleaning before confirming the room.');
    Object.assign(housekeeping,{completedByUserId:actor.user.id,completedAt:timestamp});
  }

  const updatedEvent = await database.setRecord("checkoutEvents", event.id, {
    ...event,
    metadata: { ...(event.metadata || {}), housekeeping,audit:[...(event.metadata?.audit||[]),{action,actorId:actor.user.id,at:timestamp}] },
  });
  let updatedRoom = room;

  if (action === "claim" && room.status === "ready_for_cleaning") {
    updatedRoom = await updateRoom(database, tenant.id, room.id, { status: "cleaning" });
  }

  if (action === "complete") {
    updatedRoom = await updateRoom(database, tenant.id, room.id, { status: "ready" });
    if(!input._locked)void sendRoomCompletedPush(database, {
      tenant,
      room: updatedRoom,
      event: updatedEvent,
      actorUser: actor.user,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[WebPush] room completed push failed: ${message}`);
    });
  }

  if (action === "assign" && assignedUserId && !input._locked) {
    void sendAssignmentPush(database, {
      tenant,
      room: updatedRoom,
      event: updatedEvent,
      assignedUserId,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[WebPush] assignment push failed: ${message}`);
    });
  }

  return {
    success: true,
    action,
    event: updatedEvent,
    room: updatedRoom,
    board: await getHousekeepingBoard(database, tenant.id),
  };
}

export async function registerManualHousekeepingCheckout(database, input = {}) {
  const tenant = await getTenant(database, input.tenantId);
  const actor = input.actor;

  if (!actor?.user?.id || !actor.role) {
    const error = new Error("Invalid housekeeping actor.");
    error.statusCode = 400;
    throw error;
  }

  requireHousekeepingPermission(actor.role, "manage");
  const roomId = cleanString(input.roomId);
  const roomNumber = cleanString(input.roomNumber);
  const rooms = await database.listTenantRecords("rooms", tenant.id);
  const room = rooms.find(
    (candidate) =>
      candidate.active !== false &&
      !candidate.deletedAt &&
      ((roomId && candidate.id === roomId) ||
        (roomNumber && String(candidate.number).toLowerCase() === roomNumber.toLowerCase())),
  );

  if (!room) {
    const error = new Error("Room not found.");
    error.statusCode = 404;
    throw error;
  }

  const target = await resolveAssignmentTargetByUserId(
    database,
    tenant.id,
    input.assignmentTargetUserId || input.assignedToUserId,
    actor.role==='platform_admin',
  );
  const timestamp = now();
  const metadata = {
    origin: cleanString(input.origin) || "hotelapp",
    actorUserId: actor.user.id,
    ...(cleanString(input.actorTelegramUserId)
      ? { actorTelegramUserId: cleanString(input.actorTelegramUserId) }
      : {}),
    ...(target
      ? {
          housekeeping: {
            assignedToUserId: target.user.id,
            assignedByUserId: actor.user.id,
            assignedAt: timestamp,
          },
        }
      : {}),
  };
  const result = await registerCheckout(database, tenant.id, room.id, "manual", {
    sourceIdentifier: `manual:${actor.user.id}`,
    metadata,
  });

  if (!result.duplicate && target) {
    void sendAssignmentPush(database, {
      tenant,
      room: result.room,
      event: result.event,
      assignedUserId: target.user.id,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[WebPush] manual checkout assignment push failed: ${message}`);
    });
  }

  return {
    success: true,
    duplicate: result.duplicate,
    tenantId: tenant.id,
    event: result.event,
    room: result.room,
  };
}

export async function countPendingHousekeepingRooms(database, tenantId) {
  const board = await getHousekeepingBoard(database, tenantId, { includeAccessCodes: false });
  return board.summary.total;
}

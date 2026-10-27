import {
  applyHousekeepingAction,
  getHousekeepingBoard,
  getHousekeepingStaff,
  registerManualHousekeepingCheckout,
} from "../services/housekeepingService.js";
import { requireHousekeepingPermission } from "../services/housekeepingPermissions.js";
import { getTenantRole, requireModule } from "../services/tenantService.js";

function actorFromSession(session, tenantId) {
  return {
    user: session.user,
    role: getTenantRole(session, tenantId),
  };
}

export async function handleHousekeepingRoute({ request, pathname, body, context }) {
  const { database, session } = context;
  const tenantId = await requireModule(database, session, "checkout");
  const actor = actorFromSession(session, tenantId);

  requireHousekeepingPermission(actor.role, "use");

  if (request.method === "GET" && pathname === "/api/housekeeping/board") {
    return {
      status: 200,
      payload: await getHousekeepingBoard(database, tenantId),
    };
  }

  if (request.method === "GET" && pathname === "/api/housekeeping/staff") {
    return {
      status: 200,
      payload: await getHousekeepingStaff(database, tenantId, { includePlatformAdmins: session.isPlatformAdmin }),
    };
  }

  if (request.method === "POST" && pathname === "/api/housekeeping/action") {
    return {
      status: 200,
      payload: await applyHousekeepingAction(database, {
        tenantId,
        actor,
        action: body.action,confirmed:body.confirmed===true,reason:body.reason,
        eventId: body.eventId,
        roomNumber: body.roomNumber,
        assignmentTargetUserId: body.assignmentTargetUserId || body.assignedToUserId,
      }),
    };
  }

  if (request.method === "POST" && pathname === "/api/housekeeping/manual-checkout") {
    return {
      status: 201,
      payload: await registerManualHousekeepingCheckout(database, {
        tenantId,
        actor,
        roomId: body.roomId,
        roomNumber: body.roomNumber,
        assignmentTargetUserId: body.assignmentTargetUserId || body.assignedToUserId,
      }),
    };
  }

  return undefined;
}

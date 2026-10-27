import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptUserInvitation,
  createUserInvitation,getInvitationLink,
  listTenantUsersPayload,
  revokeUserInvitation,
} from "./invitationService.js";
import { getAuthSession } from "./tenantService.js";

function createFakeDatabase(initial = {}) {
  const data = {
    tenants: {
      hotelA: {
        id: "hotelA",
        name: "Hotel A",
        slug: "hotel-a",
        active: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      hotelB: {
        id: "hotelB",
        name: "Hotel B",
        slug: "hotel-b",
        active: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    users: {},
    memberships: {},
    userInvitations: {},
    tenantModules: {},
    ...initial,
  };

  return {
    data,
    async getRecord(collection, id) {
      return data[collection]?.[id];
    },
    async setRecord(collection, id, value) {
      data[collection] ||= {};
      data[collection][id] = { ...value, id };
      return data[collection][id];
    },
    async createRecord(collection, value) {
      data[collection] ||= {};
      const id = value.id || `${collection}-${Object.keys(data[collection]).length + 1}`;
      data[collection][id] = { ...value, id };
      return data[collection][id];
    },
    async deleteRecord(collection, id) {
      delete data[collection]?.[id];
    },
    async listRecords(collection) {
      return Object.values(data[collection] || {});
    },
    async getMembershipsForUser(userId) {
      return Object.values(data.memberships || {}).filter(
        (membership) => membership.userId === userId,
      );
    },
    async getTenantModules(tenantId) {
      return Object.fromEntries(
        Object.values(data.tenantModules?.[tenantId] || {}).map((module) => [
          module.moduleId,
          module.enabled,
        ]),
      );
    },
  };
}

function tokenFromInviteUrl(invitation) {
  return decodeURIComponent(invitation.inviteUrl.split("/accept-invite/")[1]);
}

const platformSession = {
  user: { id: "platform-user", email: "owner@example.com" },
  isPlatformAdmin: true,
  memberships: [],
  activeTenantId: "",
};

const tenantAdminSession = {
  user: { id: "tenant-admin-a", email: "admin-a@example.com" },
  isPlatformAdmin: false,
  memberships: [
    {
      id: "hotelA:tenant-admin-a",
      tenantId: "hotelA",
      userId: "tenant-admin-a",
      role: "tenant_admin",
    },
  ],
  activeTenantId: "hotelA",
};

const staffSession = {
  user: { id: "staff-a", email: "staff-a@example.com" },
  isPlatformAdmin: false,
  memberships: [
    {
      id: "hotelA:staff-a",
      tenantId: "hotelA",
      userId: "staff-a",
      role: "staff",
    },
  ],
  activeTenantId: "hotelA",
};

const managerSession = {
  user: { id: "manager-a", email: "manager-a@example.com" },
  isPlatformAdmin: false,
  memberships: [
    {
      id: "hotelA:manager-a",
      tenantId: "hotelA",
      userId: "manager-a",
      role: "manager",
    },
  ],
  activeTenantId: "hotelA",
};

async function assertRejectsWithStatus(fn, statusCode) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test("platform_admin can invite users to any tenant", async () => {
  const database = createFakeDatabase();

  const invitation = await createUserInvitation(database, platformSession, "hotelB", {
    email: "New.Admin@example.com",
    role: "tenant_admin",
  });

  assert.equal(invitation.email, "new.admin@example.com");
  assert.equal(invitation.tenantId, "hotelB");
  assert.equal(invitation.role, "tenant_admin");
  assert.equal(invitation.status, "pending");
  assert.equal(invitation.token, undefined);
  assert.match(invitation.inviteUrl, /\/accept-invite\//);
});

test("tenant_admin can invite only inside their tenant", async () => {
  const database = createFakeDatabase();

  const tenantAdminInvitation = await createUserInvitation(database, tenantAdminSession, "hotelA", {
    email: "owner@example.com",
    role: "tenant_admin",
  });
  const managerInvitation = await createUserInvitation(database, tenantAdminSession, "hotelA", {
    email: "manager@example.com",
    role: "manager",
  });
  const staffInvitation = await createUserInvitation(database, tenantAdminSession, "hotelA", {
    email: "employee@example.com",
    role: "staff",
  });

  assert.equal(tenantAdminInvitation.role, "tenant_admin");
  assert.equal(managerInvitation.role, "manager");
  assert.equal(staffInvitation.role, "staff");
});

test("tenant_admin cannot invite to another tenant", async () => {
  const database = createFakeDatabase();

  await assertRejectsWithStatus(
    () =>
      createUserInvitation(database, tenantAdminSession, "hotelB", {
        email: "employee@example.com",
        role: "staff",
      }),
    403,
  );
});

test("staff cannot invite users", async () => {
  const database = createFakeDatabase();

  await assertRejectsWithStatus(
    () =>
      createUserInvitation(database, staffSession, "hotelA", {
        email: "employee@example.com",
        role: "staff",
      }),
    403,
  );
});

test("manager can manage own hotel staff but cannot grant owner access",async()=>{const db=createFakeDatabase();const invitation=await createUserInvitation(db,managerSession,"hotelA",{email:"employee@example.com",role:"staff"});assert.equal(invitation.tenantId,"hotelA");assert.ok(await listTenantUsersPayload(db,managerSession,"hotelA"));await assertRejectsWithStatus(()=>createUserInvitation(db,managerSession,"hotelA",{email:"owner@example.com",role:"tenant_admin"}),403);});

test("staff cannot list or manage tenant users", async () => {
  const database = createFakeDatabase();

  await assertRejectsWithStatus(
    () => listTenantUsersPayload(database, staffSession, "hotelA"),
    403,
  );
});

test("valid invitation creates tenant membership and marks invitation used", async () => {
  const database = createFakeDatabase();
  const invitation = await createUserInvitation(database, platformSession, "hotelA", {
    email: "employee@example.com",
    role: "staff",
  });
  const result = await acceptUserInvitation(database, {
    email: "employee@example.com",
    password: "password123",
  }, tokenFromInviteUrl(invitation));

  assert.equal(result.tenantId, "hotelA");
  assert.equal(result.membership.tenantId, "hotelA");
  assert.equal(result.membership.role, "staff");
  assert.equal(Object.values(database.data.memberships)[0].role, "staff");
  assert.ok(database.data.userInvitations[invitation.id].usedAt);
  assert.ok(result.session.id);
});

test("used invitation cannot be accepted again", async () => {
  const database = createFakeDatabase();
  const invitation = await createUserInvitation(database, platformSession, "hotelA", {
    email: "employee@example.com",
    role: "staff",
  });
  const token = tokenFromInviteUrl(invitation);

  await acceptUserInvitation(database, { email: "employee@example.com", password: "password123" }, token);

  await assertRejectsWithStatus(
    () => acceptUserInvitation(database, { email: "employee@example.com", password: "password123" }, token),
    400,
  );
});

test("expired invitation is rejected", async () => {
  const database = createFakeDatabase();
  const invitation = await createUserInvitation(database, platformSession, "hotelA", {
    email: "employee@example.com",
    role: "staff",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const token = tokenFromInviteUrl(invitation);

  await assertRejectsWithStatus(
    () => acceptUserInvitation(database, { email: "employee@example.com", password: "password123" }, token),
    400,
  );
});

test("revoked invitation is rejected", async () => {
  const database = createFakeDatabase();
  const invitation = await createUserInvitation(database, platformSession, "hotelA", {
    email: "employee@example.com",
    role: "staff",
  });
  const token = tokenFromInviteUrl(invitation);
  await revokeUserInvitation(database, platformSession, "hotelA", invitation.id);

  await assertRejectsWithStatus(
    () => acceptUserInvitation(database, { email: "employee@example.com", password: "password123" }, token),
    400,
  );
});

test("platform_admin role cannot be assigned through invitation", async () => {
  const database = createFakeDatabase();

  await assertRejectsWithStatus(
    () =>
      createUserInvitation(database, platformSession, "hotelA", {
        email: "employee@example.com",
        role: "platform_admin",
      }),
    400,
  );
});

test("user from tenant A does not get access to tenant B", async () => {
  const database = createFakeDatabase({
    users: {
      "user-a": {
        id: "user-a",
        email: "a@example.com",
        displayName: "A",
      },
    },
    memberships: {
      "hotelA:user-a": {
        id: "hotelA:user-a",
        tenantId: "hotelA",
        userId: "user-a",
        role: "staff",
      },
    },
  });

  await assertRejectsWithStatus(
    () => getAuthSession(database, { id: "user-a", email: "a@example.com" }, "hotelB"),
    403,
  );
});

test('copying an invitation never invalidates the emailed link and does not expose its encrypted token',async()=>{const db=createFakeDatabase(),invitation=await createUserInvitation(db,tenantAdminSession,'hotelA',{email:'copy@example.com',role:'staff'}),before=db.data.userInvitations[invitation.id].tokenHash;const copy=await getInvitationLink(db,tenantAdminSession,'hotelA',invitation.id,'http://127.0.0.1:5173');assert.equal(copy.inviteUrl,invitation.inviteUrl);assert.equal(db.data.userInvitations[invitation.id].tokenHash,before);assert.equal(invitation.encryptedToken,undefined);assert.notEqual(db.data.userInvitations[invitation.id].encryptedToken,tokenFromInviteUrl(invitation));});

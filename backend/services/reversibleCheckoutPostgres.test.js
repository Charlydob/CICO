import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "../databaseClient.js";
import {
  createRoom,
  registerCheckout,
  setTodayCheckoutRooms,
} from "./checkoutService.js";
import {
  applyHousekeepingAction,
  getHousekeepingBoard,
} from "./housekeepingService.js";
const url = process.env.CHECKOUT_POSTGRES_TEST_DATABASE_URL;
test(
  "PostgreSQL tenant constraints and concurrent reversible checkout/cleaning",
  { skip: !url },
  async () => {
    const db = createDatabaseClient(),
      a = randomUUID(),
      b = randomUUID(),
      user = randomUUID();
    try {
      for (const id of [a, b])
        await db.setRecord("tenants", id, {
          name: "Isolation test",
          slug: id,
          active: true,
        });
      const room = await createRoom(db, a, {
        number: "101",
        status: "occupied",
      });
      await assert.rejects(
        db.prisma.keyIdentifier.create({
          data: {
            tenantId: b,
            roomId: room.id,
            type: "rfid",
            identifier: randomUUID(),
            label: "foreign",
          },
        }),
        { code: "P2003" },
      );
      await assert.rejects(
        db.prisma.checkoutEvent.create({
          data: {
            tenantId: b,
            roomId: room.id,
            source: "manual",
            status: "registered",
          },
        }),
        { code: "P2003" },
      );
      await assert.rejects(
        db.prisma.occupancyCycle.create({
          data: { tenantId: b, roomId: room.id, cycleNumber: 99 },
        }),
        { code: "P2003" },
      );
      const today = new Date().toISOString().slice(0, 10);
      await setTodayCheckoutRooms(db, a, [room.id], today);
      assert.equal(
        (await db.getTenantRecord("rooms", a, room.id)).status,
        "occupied",
      );
      assert.equal(await db.getTenantRecord("rooms", b, room.id), undefined);
      const c = await registerCheckout(db, a, room.id, "manual");
      const actor = { user: { id: user }, role: "tenant_admin" },
        act = (action, confirmed = false) =>
          applyHousekeepingAction(db, {
            tenantId: a,
            eventId: c.event.id,
            actor,
            action,
            confirmed,
          });
      await Promise.all([act("bed_done"), act("cleaning_done")]);
      const completed = await Promise.all([act("complete"), act("complete")]);
      assert.equal(completed.filter((x) => x.duplicate).length, 1);
      await act("reopen", true);
      await act("undo_bed");
      assert.equal(
        (await getHousekeepingBoard(db, a)).items[0].housekeeping.bedDoneAt,
        null,
      );
      await act("bed_done");
      await act("complete");
      await act("undo_checkout", true);
      assert.equal(
        (await db.getTenantRecord("checkoutEvents", a, c.event.id)).status,
        "reversed",
      );
      assert.equal(
        (await db.getTenantRecord("rooms", a, room.id)).status,
        "occupied",
      );
      const second = await registerCheckout(db, a, room.id, "manual");
      assert.equal(second.duplicate, false);
      assert.notEqual(second.event.id, c.event.id);
    } finally {
      for (const id of [a, b]) await db.deleteRecord("tenants", id);
      await db.disconnect();
    }
  },
);

import {
  createUserInvitation,
  acceptUserInvitation,
  getInvitationLink,
} from "./invitationService.js";
import { hashPassword } from "./sessionService.js";
test(
  "PostgreSQL invitation acceptance is email-bound, transactional and single-use under concurrency",
  { skip: !url },
  async () => {
    const db = createDatabaseClient(),
      hotel = randomUUID(),
      admin = randomUUID(),
      email = randomUUID() + "@invitation-test.example";
    try {
      await db.setRecord("tenants", hotel, {
        name: "Invitation isolation",
        slug: hotel,
        active: true,
      });
      await db.setRecord("users", admin, {
        email: randomUUID() + "@admin-test.example",
        passwordHash: await hashPassword("Local-test-password-123"),
        displayName: "Invitation QA",
        active: true,
      });
      const session = {
        user: { id: admin },
        isPlatformAdmin: true,
        memberships: [],
        activeTenantId: hotel,
      };
      const invited = await createUserInvitation(
          db,
          session,
          hotel,
          { email, role: "staff" },
          { baseUrl: "https://example.test" },
        ),
        copy = await getInvitationLink(
          db,
          session,
          hotel,
          invited.id,
          "https://example.test",
        );
      assert.equal(copy.inviteUrl, invited.inviteUrl);
      const token = new URL(invited.inviteUrl).pathname.split("/").at(-1);
      await assert.rejects(
        acceptUserInvitation(
          db,
          {
            email: "foreign@example.test",
            password: "Local-test-password-123",
          },
          token,
        ),
        { statusCode: 403 },
      );
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          acceptUserInvitation(
            db,
            { email, password: "Local-test-password-123" },
            token,
          ),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.statusCode,
        400,
      );
      const user = await db.prisma.user.findUnique({ where: { email } });
      assert.equal((await db.getMembershipsForUser(user.id)).length, 1);
      assert.equal(
        (await db.getMembershipsForUser(user.id))[0].tenantId,
        hotel,
      );
    } finally {
      await db.deleteRecord("tenants", hotel);
      await db.prisma.user.deleteMany({
        where: { OR: [{ id: admin }, { email }] },
      });
      await db.disconnect();
    }
  },
);

import { recordConnectedPayment } from "./paymentsService.js";
test(
  "PostgreSQL Connect payment events and retries create one tenant-bound check-in",
  { skip: !url },
  async () => {
    const db = createDatabaseClient(),
      hotel = randomUUID(),
      other = randomUUID();
    try {
      for (const id of [hotel, other])
        await db.setRecord("tenants", id, {
          name: "Payment QA",
          slug: id,
          active: true,
        });
      let calls = 0;
      const input = {
        stripeEventId: "evt_" + randomUUID(),
        stripePaymentIntentId: "pi_" + randomUUID(),
      };
      const process = async (tx) => {
        calls++;
        return tx.createCheckIn({
          tenantId: hotel,
          ...input,
          reservationCode: "PAYMENT-QA",
          fullName: "QA",
          source: "stripe",
          checkInAt: new Date().toISOString(),
        });
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          recordConnectedPayment(db, hotel, "acct_qa", input, process),
        ),
      );
      assert.equal(calls, 1);
      assert.equal(results.filter((r) => r.duplicate).length, 5);
      assert.equal((await db.listTenantRecords("checkIns", other)).length, 0);
      assert.equal(
        (
          await recordConnectedPayment(
            db,
            hotel,
            "acct_qa",
            { ...input, stripeEventId: "evt_retry" },
            process,
          )
        ).duplicate,
        true,
      );
      await assert.rejects(
        recordConnectedPayment(
          db,
          hotel,
          "acct_qa",
          { stripeEventId: "evt_fail" },
          async (tx) => {
            await tx.createCheckIn({
              tenantId: hotel,
              stripeEventId: "evt_fail",
              reservationCode: "FAIL",
              fullName: "QA",
              source: "stripe",
              checkInAt: new Date().toISOString(),
            });
            throw Error("rollback");
          },
        ),
        /rollback/,
      );
      assert.equal((await db.listTenantRecords("checkIns", hotel)).length, 1);
    } finally {
      for (const id of [hotel, other]) await db.deleteRecord("tenants", id);
      await db.disconnect();
    }
  },
);

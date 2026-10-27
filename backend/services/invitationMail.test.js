import test from "node:test";
import assert from "node:assert/strict";
import { sendUserInvitationNotification } from "./notificationService.js";
const input = {
  invitation: {
    id: "invitation",
    email: "employee@example.test",
    expiresAt: "2026-11-02T00:00:00Z",
  },
  tenant: { name: "Hotel\r\nInjected" },
  inviteUrl: "https://cico.example/accept-invite/opaque",
};
test("invitation transport reports missing configuration, rejected delivery and provider acceptance honestly", async () => {
  let calls = 0;
  const transport = async (url, options) => {
    calls++;
    assert.equal(url, "https://mail.example/send");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer transport-token");
    const body = JSON.parse(options.body);
    assert.equal(body.to, input.invitation.email);
    assert.equal(body.inviteUrl, input.inviteUrl);
    assert.equal(/[\r\n]/.test(body.subject), false);
    return { ok: true };
  };
  assert.equal(
    (
      await sendUserInvitationNotification({
        ...input,
        configuration: {},
        transport,
      })
    ).status,
    "not_configured",
  );
  assert.equal(
    (
      await sendUserInvitationNotification({
        ...input,
        configuration: {
          INVITATION_MAIL_URL: "http://mail.example/send",
          INVITATION_MAIL_TOKEN: "transport-token",
        },
        transport,
      })
    ).status,
    "failed",
  );
  assert.equal(calls, 0);
  const configured = {
    ...input,
    configuration: {
      INVITATION_MAIL_URL: "https://mail.example/send",
      INVITATION_MAIL_TOKEN: "transport-token",
    },
  };
  assert.equal(
    (await sendUserInvitationNotification({ ...configured, transport })).status,
    "accepted",
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await sendUserInvitationNotification({
        ...configured,
        transport: async () => ({ ok: false }),
      })
    ).status,
    "failed",
  );
  assert.equal(
    (
      await sendUserInvitationNotification({
        ...configured,
        transport: async () => {
          throw Error("private provider detail");
        },
      })
    ).status,
    "failed",
  );
});

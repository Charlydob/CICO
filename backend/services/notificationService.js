function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanTelegramId(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value).trim()
    : "";
}

function cleanTelegramIntegerId(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  const raw = cleanTelegramId(value);
  if (!raw) {
    return "";
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && String(parsed) === raw ? parsed : raw;
}

export async function getSavedHousekeepingBoard(database, tenantId) {
  if (!database || !tenantId) {
    return {};
  }

  const stored = await database.getRecord("diagnostics", "telegramHousekeepingBoards");
  const boards = stored?.value && typeof stored.value === "object" ? stored.value : stored || {};
  const board = boards[tenantId];

  if (!board || typeof board !== "object" || !board.messageId) {
    return {};
  }

  return {
    tenantId: cleanString(board.tenantId),
    chatId: cleanTelegramId(board.chatId),
    messageId: cleanTelegramIntegerId(board.messageId),
    threadId: cleanTelegramIntegerId(board.threadId),
    updatedAt: cleanString(board.updatedAt),
  };
}

function publicDiagnostics(diagnostics = {}) {
  return {
    lastAttemptAt: cleanString(diagnostics.lastAttemptAt),
    lastSuccessAt: cleanString(diagnostics.lastSuccessAt),
    lastError: cleanString(diagnostics.lastError),
    httpStatus: diagnostics.httpStatus === undefined ? undefined : Number(diagnostics.httpStatus),
    checkoutEventId: cleanString(diagnostics.checkoutEventId),
    room: cleanString(diagnostics.room),
    source: cleanString(diagnostics.source),
  };
}

function diagnosticPayload({ event, room, patch = {} }) {
  return {
    lastAttemptAt: new Date().toISOString(),
    checkoutEventId: cleanString(event?.id),
    room: cleanString(room?.number),
    source: cleanString(event?.source),
    ...patch,
  };
}

async function saveTelegramDiagnostics(database, tenantId, diagnostics) {
  if (!database || !tenantId) {
    return;
  }

  const current = (await database.getRecord("tenantSettings", tenantId)) || {};
  const notifications = current.notifications || {};
  const telegram = notifications.telegram || {};

  await database.setRecord("tenantSettings", tenantId, {
    ...current,
    notifications: {
      ...notifications,
      telegram: {
        ...telegram,
        diagnostics: {
          ...(telegram.diagnostics || {}),
          ...diagnostics,
        },
      },
    },
  });
}

export function getPublicNotificationSettings(settings = {}) {
  const telegram = settings.telegram || {};

  return {
    telegram: {
      enabled: Boolean(telegram.enabled),
      chatId: cleanTelegramId(telegram.chatId),
      chatTitle: cleanString(telegram.chatTitle),
      chatType: cleanString(telegram.chatType),
      connectedAt: cleanString(telegram.connectedAt),
      diagnostics: publicDiagnostics(telegram.diagnostics),
    },
  };
}

export async function sendCheckoutNotification({
  database,
  tenant,
  tenantSettings,
  room,
  event,
  housekeepingBoard,
}) {
  const telegram = tenantSettings?.notifications?.telegram || tenantSettings?.telegram || {};
  const tenantId = tenant?.id || event?.tenantId;

  if (!telegram.enabled || !cleanTelegramId(telegram.chatId)) {
    const diagnostics = diagnosticPayload({
      event,
      room,
      patch: {
        lastError: "Telegram notification is not enabled or chatId is missing.",
        httpStatus: undefined,
      },
    });
    await saveTelegramDiagnostics(database, tenantId, diagnostics);
    return { sent: false, skipped: true, diagnostics };
  }

  const webhookUrl = cleanString(process.env.N8N_CHECKOUT_WEBHOOK_URL);
  const webhookSecret = cleanString(process.env.N8N_CHECKOUT_WEBHOOK_SECRET);

  if (!webhookUrl || !webhookSecret) {
    console.warn("[Notifications] n8n checkout webhook is not configured.");
    const diagnostics = diagnosticPayload({
      event,
      room,
      patch: {
        lastError: "n8n checkout webhook is not configured.",
        httpStatus: undefined,
      },
    });
    await saveTelegramDiagnostics(database, tenantId, diagnostics);
    return { sent: false, skipped: true, diagnostics };
  }

  const savedHousekeepingBoard =
    housekeepingBoard === undefined
      ? await getSavedHousekeepingBoard(database, tenantId)
      : housekeepingBoard;
  const payload = {
    event: "checkout.completed",
    tenant: {
      id: tenant?.id || event.tenantId,
      slug: tenant?.slug || "",
      name: tenant?.name || "",
    },
    room: {
      id: room.id,
      number: room.number,
      name: room.name || "",
    },
    checkout: {
      id: event.id,
      source: event.source,
      timestamp: event.timestamp,
    },
    notification: {
      chatId: cleanTelegramId(telegram.chatId),
      housekeepingBoard: savedHousekeepingBoard,
    },
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HotelApp-Secret": webhookSecret,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = new Error(`n8n HTTP ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }

    const diagnostics = diagnosticPayload({
      event,
      room,
      patch: {
        lastSuccessAt: new Date().toISOString(),
        lastError: "",
        httpStatus: response.status,
      },
    });
    await saveTelegramDiagnostics(database, tenantId, diagnostics);

    return { sent: true, httpStatus: response.status, diagnostics };
  } catch (error) {
    const httpStatus = Number(error?.httpStatus) || undefined;
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn(`[Notifications] n8n checkout webhook failed: ${message}`);
    const diagnostics = diagnosticPayload({
      event,
      room,
      patch: {
        lastError: message,
        httpStatus,
      },
    });
    await saveTelegramDiagnostics(database, tenantId, diagnostics);

    return { sent: false, error: message, httpStatus, diagnostics };
  }
}

export async function sendHousekeepingBoardRefresh({ tenant, tenantSettings }) {
  const telegram = tenantSettings?.notifications?.telegram || tenantSettings?.telegram || {};

  if (!telegram.enabled || !cleanTelegramId(telegram.chatId)) {
    return { sent: false, skipped: true };
  }

  const webhookUrl = cleanString(process.env.N8N_CHECKOUT_WEBHOOK_URL);
  const webhookSecret = cleanString(process.env.N8N_CHECKOUT_WEBHOOK_SECRET);

  if (!webhookUrl || !webhookSecret) {
    console.warn("[Notifications] n8n checkout webhook is not configured.");
    return { sent: false, skipped: true };
  }

  const payload = {
    event: "housekeeping.board.refresh",
    tenant: {
      id: tenant?.id || tenantSettings?.tenantId || "",
      slug: tenant?.slug || "",
      name: tenant?.name || "",
    },
    notification: {
      chatId: cleanTelegramId(telegram.chatId),
      timezone: "Europe/Zurich",
    },
    reason: "checkout_today_changed",
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HotelApp-Secret": webhookSecret,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`n8n HTTP ${response.status}`);
    }

    return { sent: true, httpStatus: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn(`[Notifications] n8n housekeeping board refresh failed: ${message}`);
    return { sent: false, error: message };
  }
}

export async function sendTestCheckoutNotification({ database, tenant, tenantSettings }) {
  const event = {
    id: `test-${Date.now()}`,
    tenantId: tenant?.id || tenantSettings?.tenantId || "",
    source: "test",
    timestamp: new Date().toISOString(),
  };
  const room = {
    id: "test-room",
    number: "Test",
    name: "Telegram test",
  };

  return sendCheckoutNotification({
    database,
    tenant,
    tenantSettings,
    room,
    event,
  });
}

export async function getTelegramDiagnostics(database, tenantId) {
  const settings = await database.getRecord("tenantSettings", tenantId);
  return publicDiagnostics(settings?.notifications?.telegram?.diagnostics);
}

export async function sendUserInvitationNotification({invitation,tenant,inviteUrl,transport=fetch,configuration=process.env}){
  const url=configuration.INVITATION_MAIL_URL,token=configuration.INVITATION_MAIL_TOKEN;
  if(!url||!token)return {sent:false,status:"not_configured",invitationId:invitation.id};
  if(!/^https:\/\//.test(url))return {sent:false,status:"failed",invitationId:invitation.id};
  try{
    const response=await transport(url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({schemaVersion:1,event:"user_invited",to:invitation.email,subject:("Invitation to "+(tenant?.name||"your hotel")).replace(/[\r\n]/g," ").slice(0,180),text:"You have been invited to join "+(tenant?.name||"your hotel")+" on CICO. Accept your invitation: "+inviteUrl,inviteUrl,expiresAt:invitation.expiresAt}),signal:AbortSignal.timeout(10000),redirect:"error"});
    return {sent:response.ok,status:response.ok?"accepted":"failed",invitationId:invitation.id};
  }catch{return {sent:false,status:"failed",invitationId:invitation.id};}
}

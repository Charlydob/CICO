// Tenant-scoped read-only diagnostics for the physical Checkout Box -> CICO path.
// Do not include device credentials, full raw frames or webhook secrets.
export async function getCheckoutBoxIngestDiagnostics(prisma, tenantId, now = new Date()) {
  const devices = await prisma.device.findMany({
    where: { tenantId, hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1" },
    orderBy: { name: "asc" },
    select: {
      id: true, deviceId: true, name: true, status: true,
      lastSeenAt: true, lastRfid: true, lastRssi: true,
      configRejectedReason: true,
      rfidReadings: {
        orderBy: { createdAt: "desc" }, take: 1,
        select: {
          createdAt: true, uid: true, room: true, result: true,
          authorized: true, active: true,
        },
      },
      events: {
        where: { type: { in: [
          "RFID_READ", "WIFI_CONNECTED", "WIFI_DISCONNECTED", "CONFIG_REJECTED", "BOOT",
        ] } },
        orderBy: { createdAt: "desc" }, take: 3,
        select: { type: true, createdAt: true },
      },
    },
  });
  return {
    checkedAt: now.toISOString(),
    devices: devices.map((device) => {
      const lastSeenMs = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : NaN;
      const heartbeatAgeSeconds = Number.isFinite(lastSeenMs)
        ? Math.max(0, Math.round((now.getTime() - lastSeenMs) / 1000))
        : null;
      return {
        id: device.id, deviceId: device.deviceId, name: device.name,
        online: heartbeatAgeSeconds !== null && heartbeatAgeSeconds <= 120,
        lastSeenAt: device.lastSeenAt,
        heartbeatAgeSeconds,
        lastRssi: device.lastRssi,
        lastRfidFromHeartbeat: device.lastRfid,
        configRejectedReason: device.configRejectedReason,
        lastReading: device.rfidReadings[0] ?? null,
        recentEvents: device.events,
      };
    }),
  };
}

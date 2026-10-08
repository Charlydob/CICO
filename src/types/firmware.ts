export interface FirmwareRelease {
  id: string;
  version: string;
  buildId: string;
  hardwareModel: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  releaseNotes: string;
  status: string;
  signature: string | null;
  createdAt: string;
}
export interface OtaUpdate {
  id: string;
  status: string;
  progress: number;
  resultCode: string | null;
  createdAt: string;
  updatedAt: string;
  stalled: boolean;
  release: FirmwareRelease;
  events?: Array<{
    id: string;
    status: string;
    progress: number;
    resultCode: string | null;
    createdAt: string;
  }>;
}
export interface PhysicalDevice {
  id: string;
  deviceId: string;
  name: string;
  tenantId: string | null;
  hardwareModel: string;
  status: string;
  currentFirmwareVersion: string | null;
  currentBuildId: string | null;
  targetFirmwareVersion: string | null;
  configVersion: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  lastRssi: number | null;
  uptime: number | null;
  freeHeap: number | null;
  psram: number | null;
  lastResetReason: string | null;
  lastOtaStatus: string | null;
  lastOtaResult: string | null;
  lastRfid: string | null;
  lastRfidRaw: string | null;
  trapState: string | null;
  servoDiagnosticState: "INACTIVE" | "RUNNING" | "COMPLETED" | "ERROR" | null;
  servoDiagnosticRemaining: number | null;
  desiredConfig: {
    version?: string;
    closedAngle?: number;
    openAngle?: number;
    holdMs?: number;
    allowedRfids?: string[];
  };
  credentialConfigured: boolean;
  latestUpdate?: OtaUpdate | null;
  updates?: OtaUpdate[];
  commands?: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: string;
    expiresAt: string;
    payload?: Record<string, unknown>;
    result?: { ok: boolean; value: string } | null;
  }>;
  events?: Array<{ id: string; type: string; detail: string | null; uptimeMs: number; createdAt: string }>;
  tenant?: { id: string; name: string } | null;
}

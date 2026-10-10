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
  reconciliation?: {
    installedVersion: string | null;
    installedBuild: string | null;
    versionMatches: boolean;
    buildMatches: boolean;
    state: "INSTALLED_MATCHES_RELEASE"|"INSTALLED_BUILD_MISMATCH"|"INSTALLED_VERSION_DIFFERS";
  };
  events?: Array<{
    id: string;
    status: string;
    progress: number;
    resultCode: string | null;
    createdAt: string;
  }>;
}
export interface CheckoutBoxConfiguration {
  version?: string;
  checksum?: string;
  closedAngle: number;
  openAngle: number;
  holdMs: number;
  duplicateRfidMs: number;
  activationCooldownMs: number;
  motionStepMs: number;
  heartbeatSec: number;
  pollSec: number;
  diagnosticEnabled: boolean;
  diagnosticTimeoutSec: number;
  startupBehavior: "CLOSED"|"KEEP_LAST";
  disconnectBehavior: "KEEP_LOCAL"|"CLOSE";
  allowedRfids?: string[];
}
export interface DeviceRfidKey {
  id:string; uid:string; name:string; room:string; authorized:boolean; active:boolean;
  firstSeenAt:string|null; lastSeenAt:string|null; createdAt:string; updatedAt:string;
}
export interface DeviceRfidReading {
  id:string; deviceId:string; tenantId:string|null; keyId:string|null;
  checkoutEventId:string|null; uid:string; keyName:string; room:string;
  hotelName:string; authorized:boolean; active:boolean; duplicate:boolean;
  eventType:"RFID_READ"|"RETURN_RECORDED"; result:string;
  diagnostic:string|null; deviceUptimeMs:number; createdAt:string;
}
export interface DeviceHistoryPage<T> {
  items:T[]; total:number; page:number; pageSize:number; pages:number;
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
  configChecksum:string|null;
  authorizedRfidCount:number|null;
  configAppliedAt:string|null;
  configRejectedReason:string|null;
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
  desiredConfig: Partial<CheckoutBoxConfiguration>;
  appliedConfig: Partial<CheckoutBoxConfiguration>;
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
  rfidKeys?: DeviceRfidKey[];
  rfidReadings?: DeviceRfidReading[];
  tenantAssignments?: Array<{
    id:string; fromTenantId:string|null; fromTenantName:string;
    toTenantId:string|null; toTenantName:string; createdAt:string;
  }>;
  historyTotals?: { rfidReadings:number; commands:number; otaUpdates:number };
  tenant?: { id: string; name: string } | null;
}

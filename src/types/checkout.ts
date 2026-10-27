export type RoomStatus =
  | "occupied"
  | "checkout_received"
  | "ready_for_cleaning"
  | "cleaning"
  | "ready"
  | "unknown";

export type CheckoutSource = "qr" | "nfc" | "rfid" | "manual" | "pms" | "other";
export type KeyIdentifierType = "qr" | "nfc" | "rfid";

export interface Room {
  id: string;
  tenantId: string;
  number: string;
  name?: string;
  accessCode: string | null;
  active: boolean;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  lastCheckoutAt?: string;
  lastCheckoutSource?: CheckoutSource;
  checkoutDueDate?: string;
  checkoutDueSource?: "manual" | "reservation_api";
  lastCleanedAt?: string;
}

export interface KeyIdentifier {
  id: string;
  tenantId: string;
  roomId: string;
  type: KeyIdentifierType;
  identifier: string;
  label: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  checkoutUrl?: string;
}

export interface CheckoutEvent {
  id: string;
  tenantId: string;
  roomId: string;
  source: CheckoutSource;
  sourceIdentifier?: string;
  timestamp: string;
  status: "registered" | "duplicate" | "ignored" | "reversed";
  metadata?: Record<string, unknown>;
}

export interface CheckoutOverview {
  rooms: Room[];
  events: CheckoutEvent[];
  publicUrl: string;
  publicQrDataUrl?: string;
  todayDate: string;
}

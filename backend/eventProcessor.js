import {
  applyTemporalAssociation,
  buildDetectionPayload,
  normalizePlate,
  parseConfigNumber,
} from "../shared/detectionLogic.mjs";
import { getReservations } from "./reservationService.js";
import {
  getEventDetectedAt,
  getRecognizedLicensePlate,
} from "./frigateClient.js";
import { ensureRoomOccupiedCycle } from "./services/checkoutService.js";

export function createEventProcessor({
  database,
  frigateClient,
  fileStorage,
  processedEvents,
  plateCooldown,
  tenantId,
  onDetectionStored,
  onCheckInStored,
}) {
  function getMatchingOptions() {
    return {
      windowMinutes: parseConfigNumber(process.env.MATCH_TIME_WINDOW_MINUTES, 15),
      autoConfidenceThreshold: parseConfigNumber(
        process.env.MATCH_AUTO_CONFIDENCE_THRESHOLD,
        0.8,
      ),
    };
  }

  function getPlateCooldownMinutes() {
    return parseConfigNumber(process.env.PLATE_COOLDOWN_MINUTES, 15);
  }

  function getPlatePresenceTimeoutMinutes() {
    return parseConfigNumber(process.env.PLATE_PRESENCE_TIMEOUT_MINUTES, 30);
  }

  function getPositiveDate(value) {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  function isPresenceExpired(plateState, detectedAt) {
    if (!plateState?.currentlyPresent || !plateState.lastSeenAt) {
      return false;
    }

    const detectedTime = getPositiveDate(detectedAt);
    const lastSeenTime = getPositiveDate(plateState.lastSeenAt);

    if (detectedTime === undefined || lastSeenTime === undefined) {
      return false;
    }

    return detectedTime - lastSeenTime > getPlatePresenceTimeoutMinutes() * 60000;
  }

  function getAssociationStatePatch(detection) {
    if (detection.associationStatus !== "matched") {
      return {
        associationStatus: detection.associationStatus,
        associationMethod: detection.associationMethod,
        confidence: detection.confidence,
      };
    }

    return {
      activeReservationCode: detection.reservationCode,
      activeRoom: detection.room,
      activeGuestName: detection.guestName,
      associationStatus: detection.associationStatus,
      associationMethod: detection.associationMethod,
      confidence: detection.confidence,
    };
  }

  async function updatePlateStateFromDetection(detection) {
    if(detection.tenantId&&detection.tenantId!==tenantId)return;
    const plate = normalizePlate(detection.plate);
    if (!plate) {
      return;
    }

    const currentState = await database.getPlateState(plate);
    await database.updatePlateState(plate, {
      plate,
      currentlyPresent: true,
      firstSeenAt: currentState?.firstSeenAt || detection.detectedAt,
      lastSeenAt: detection.detectedAt,
      lastDetectionId: detection.id || currentState?.lastDetectionId,
      ...getAssociationStatePatch(detection),
    });
  }

  async function updatePlateStateFromAssociation(detection) {
    if(detection.tenantId&&detection.tenantId!==tenantId)return;
    const plate = normalizePlate(detection.plate);
    if (!plate) {
      return;
    }

    const currentState = await database.getPlateState(plate);
    if (
      currentState?.activeReservationCode &&
      currentState.activeReservationCode !== detection.reservationCode
    ) {
      console.log(
        `[PlateState] ${plate} already assigned to ${currentState.activeReservationCode} - temporal reassignment ignored`,
      );
      return;
    }

    await database.updatePlateState(plate, {
      plate,
      currentlyPresent: currentState?.currentlyPresent ?? true,
      firstSeenAt: currentState?.firstSeenAt || detection.detectedAt,
      lastSeenAt: currentState?.lastSeenAt || detection.detectedAt,
      lastDetectionId: detection.id || currentState?.lastDetectionId,
      ...getAssociationStatePatch(detection),
    });
  }

  async function shouldIgnoreDetectionForPlateState(plate, detectedAt) {
    const plateState = await database.getPlateState(plate);

    if (!plateState) {
      return false;
    }

    if (isPresenceExpired(plateState, detectedAt)) {
      await database.updatePlateState(plate, {
        currentlyPresent: false,
      });

      if (!plateState.activeReservationCode) {
        return false;
      }
    }

    if (plateState.currentlyPresent && !isPresenceExpired(plateState, detectedAt)) {
      await database.updatePlateState(plate, {
        lastSeenAt: detectedAt,
      });
      console.log(`[PlateState] ${plate} already present - event ignored`);
      return true;
    }

    if (plateState.activeReservationCode) {
      await database.updatePlateState(plate, {
        currentlyPresent: true,
        lastSeenAt: detectedAt,
        seenAgainAt: detectedAt,
      });
      console.log(
        `[PlateState] ${plate} already assigned to ${plateState.activeReservationCode} - event ignored`,
      );
      return true;
    }

    return false;
  }

  async function refreshExpiredPlateStates(now = new Date().toISOString()) {
    const plateStates = await database.getPlateStates();

    for (const plateState of plateStates) {
      if (!isPresenceExpired(plateState, now)) {
        continue;
      }

      await database.updatePlateState(plateState.plate || plateState.id, {
        currentlyPresent: false,
      });
    }
  }

  function findReservationByCode(reservations, reservationCode) {
    const normalizedCode = String(reservationCode ?? "").trim().toLowerCase();
    return reservations.find(
      (reservation) => reservation.reservationCode.toLowerCase() === normalizedCode,
    );
  }

  async function findRoomByNumber(checkInTenantId, roomNumber) {
    const normalizedRoom = String(roomNumber ?? "").trim();

    if (!normalizedRoom) {
      return undefined;
    }

    return (await database.listTenantRecords("rooms", checkInTenantId)).find(
      (room) => room.number === normalizedRoom && room.active !== false,
    );
  }

  async function clearAuthorizedEvidence(detection) {
    if (
      detection.parkingStatus !== "paid" ||
      detection.associationStatus !== "matched" ||
      (!detection.localSnapshotPath && !detection.localVideoPath)
    ) {
      return detection;
    }

    for (const evidencePath of [detection.localSnapshotPath, detection.localVideoPath]) {
      if (!evidencePath) {
        continue;
      }

      try {
        await fileStorage.deleteEvidencePath(evidencePath);
        console.log(`[Evidence] Deleted authorized evidence: ${evidencePath}`);
      } catch (error) {
        console.warn(`[Evidence] Could not delete ${evidencePath}: ${error.message}`);
      }
    }

    await database.updateDetection(detection.id, {
      localSnapshotPath: null,
      localVideoPath: null,
    });

    return {
      ...detection,
      localSnapshotPath: undefined,
      localVideoPath: undefined,
    };
  }

  async function applyTemporalMatchingToStoredDetections(checkIns) {
    const detections = await database.getDetections();
    const options = getMatchingOptions();

    for (const detection of detections) {
      if (detection.associationStatus !== "unmatched") {
        continue;
      }

      const plate = normalizePlate(detection.plate);
      const plateState = plate && (!detection.tenantId||detection.tenantId===tenantId) ? await database.getPlateState(plate) : undefined;
      if (
        plateState?.activeReservationCode &&
        plateState.activeReservationCode !== detection.reservationCode
      ) {
        console.log(
          `[PlateState] ${plate} already assigned to ${plateState.activeReservationCode} - temporal matching skipped`,
        );
        continue;
      }

      const scoped=checkIns.filter(c=>(c.tenantId||tenantId)===(detection.tenantId||tenantId));
      const updated = applyTemporalAssociation(detection, scoped, options);

      if (
        updated.associationStatus === detection.associationStatus &&
        updated.confidence === detection.confidence &&
        !updated.associationCandidates
      ) {
        continue;
      }

      await database.updateDetection(detection.id, {
        parkingStatus: updated.parkingStatus,
        associationStatus: updated.associationStatus,
        associationMethod: updated.associationMethod,
        reservationCode: updated.reservationCode,
        room: updated.room,
        guestName: updated.guestName,
        guestEmail: updated.guestEmail,
        checkInAt: updated.checkInAt,
        timeDifferenceMinutes: updated.timeDifferenceMinutes,
        confidence: updated.confidence,
        associationCandidates: updated.associationCandidates,
      });

      await clearAuthorizedEvidence(updated);
      await updatePlateStateFromAssociation(updated);
    }
  }

  async function buildDetectionWithTemporalMatching(input, reservations) {
    const directPayload = buildDetectionPayload(input, reservations);

    if (
      directPayload.associationStatus !== "unmatched" ||
      directPayload.associationMethod === "plate"
    ) {
      return directPayload;
    }

    const ownTenant=input.tenantId||tenantId;
    const checkIns=(await database.getCheckIns()).filter(c=>(c.tenantId||tenantId)===ownTenant);
    return applyTemporalAssociation({...directPayload,tenantId:ownTenant}, checkIns, getMatchingOptions());
  }

  async function processFrigateDetection(input) {
    const detectionTenantId = input.tenantId || tenantId;
    const reservations = detectionTenantId===tenantId?await getReservations():[];
    const detectionPayload = await buildDetectionWithTemporalMatching(input, reservations);
    const createdDetection = await database.createDetection({
      ...detectionPayload,
      tenantId: detectionTenantId,
    });
    const detection = await clearAuthorizedEvidence(createdDetection);
    await updatePlateStateFromDetection(detection);

    if (detectionPayload.associationStatus === "matched") {
      console.log(
        `[Reservations] Plate match: ${detectionPayload.plate} -> ${detectionPayload.reservationCode || "-"} / room ${detectionPayload.room || "-"}`,
      );
    } else {
      console.log(`[Reservations] No unique match: ${detectionPayload.associationStatus}`);
    }

    console.log("[Database] Detection stored");
    onDetectionStored?.(detection);
    return detection;
  }

  async function processDetectionWithCooldown(input) {
    if(input.tenantId&&input.tenantId!==tenantId)return processFrigateDetection(input);
    const plate = normalizePlate(input.plate);
    const detectedAt = input.detectedAt || new Date().toISOString();

    if (await shouldIgnoreDetectionForPlateState(plate, detectedAt)) {
      return undefined;
    }

    if (
      plateCooldown?.isCoolingDown(
        plate,
        detectedAt,
        getPlateCooldownMinutes(),
      )
    ) {
      console.log(`[Cooldown] Ignored repeated plate ${plate}`);
      return undefined;
    }

    const detection = await processFrigateDetection({
      ...input,
      plate,
      detectedAt,
    });
    await plateCooldown?.mark(plate, detectedAt);
    return detection;
  }

  async function processCheckInEvent(input) {
    const reservationCode = String(input.reservationCode ?? "").trim();
    const fullName = String(input.fullName ?? "").trim();
    const now = new Date().toISOString();

    if (!reservationCode) {
      await database.updateStripeDiagnostic({
        lastEventReceivedAt: now,
        lastStripeEventId: input.stripeEventId,
        lastReservationNumber: "",
        lastStatus: "invalid event",
        lastError: "reservationNumber is missing.",
      });
      throw new Error("Cannot create a check-in without reservationNumber.");
    }

    const checkInTenantId = input.tenantId || tenantId;
    const reservations=checkInTenantId===tenantId?await getReservations():[];
    const reservation = findReservationByCode(reservations, reservationCode);
    const matchedRoom = await findRoomByNumber(checkInTenantId, reservation?.room || input.room);
    const checkIn = await database.createCheckIn({
      tenantId: checkInTenantId,
      reservationCode,
      fullName: reservation?.name || fullName || "No name",
      checkInAt: input.checkInAt || now,
      source: input.source || "stripe",
      stripeEventId: input.stripeEventId,
      stripePaymentIntentId: input.stripePaymentIntentId,
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      room: reservation?.room,
      guestEmail: reservation?.email || input.email,
      plate: reservation?.plate,
      parkingValid: reservation?.parkingValid,
      paymentStatus: input.paymentStatus,
      metadata: input.metadata,
      createdAt: now,
    });

    if (matchedRoom) {
      await ensureRoomOccupiedCycle(database, checkInTenantId, matchedRoom.id, {
        reservationCode,
        guestName: checkIn.fullName,
        guestEmail: checkIn.guestEmail,
        departureAt: reservation?.departureAt || input.departureAt,
        metadata: {
          source: input.source || "stripe",
          checkInId: checkIn.id,
          stripeEventId: input.stripeEventId,
          stripePaymentIntentId: input.stripePaymentIntentId,
          stripeCheckoutSessionId: input.stripeCheckoutSessionId,
        },
      });

      await database.setRecord("rooms", matchedRoom.id, {
        ...matchedRoom,
        status: "occupied",
        updatedAt: now,
      });
    }

    await database.updateStripeDiagnostic({
      lastEventReceivedAt: now,
      lastStripeEventId: input.stripeEventId,
      lastCheckInCreatedAt: checkIn.createdAt,
      lastCheckInId: checkIn.id,
      lastReservationNumber: reservationCode,
      lastFullName: checkIn.fullName,
      lastStatus: reservation ? "matched reservation" : "reservation not found",
      lastError: null,
    });

    await applyTemporalMatchingToStoredDetections(await database.getCheckIns());
    onCheckInStored?.(checkIn);
    return checkIn;
  }

  async function processFrigateEvent(event) {
    const eventId = event.id;

    if (!eventId || processedEvents.has(eventId)) {
      return undefined;
    }

    const plate = normalizePlate(getRecognizedLicensePlate(event));
    if (!plate) {
      return undefined;
    }

    const detectedAt = getEventDetectedAt(event);
    const camera = event.camera || "unknown";

    if (await shouldIgnoreDetectionForPlateState(plate, detectedAt)) {
      await processedEvents.mark(eventId);
      await plateCooldown?.mark(plate, detectedAt);
      return undefined;
    }

    if (
      plateCooldown?.isCoolingDown(
        plate,
        detectedAt,
        getPlateCooldownMinutes(),
      )
    ) {
      console.log(`[Cooldown] Ignored repeated plate ${plate}`);
      await processedEvents.mark(eventId);
      return undefined;
    }

    console.log(`[LPR] New plate: ${plate}`);

    let localSnapshotPath;
    let localVideoPath;

    try {
      const snapshotBuffer = await frigateClient.getSnapshotBuffer(eventId);
      localSnapshotPath = await fileStorage.saveEvidenceBuffer({
        kind: "snapshot",
        eventId,
        plate,
        detectedAt,
        buffer: snapshotBuffer,
      });

      if (localSnapshotPath) {
        console.log("[Evidence] Snapshot saved");
      }
    } catch (error) {
      console.warn(`[Evidence] Snapshot not saved: ${error.message}`);
    }

    if (event.has_clip !== false) {
      try {
        const clipBuffer = await frigateClient.getClipBuffer(eventId);
        localVideoPath = await fileStorage.saveEvidenceBuffer({
          kind: "clip",
          eventId,
          plate,
          detectedAt,
          buffer: clipBuffer,
        });

        if (localVideoPath) {
          console.log("[Evidence] Clip saved");
        }
      } catch (error) {
        console.warn(`[Evidence] Clip not saved: ${error.message}`);
      }
    }

    const detection = await processFrigateDetection({
      plate,
      detectedAt,
      camera,
      localSnapshotPath,
      localVideoPath,
    });

    await processedEvents.mark(eventId);
    await plateCooldown?.mark(plate, detectedAt);
    return detection;
  }

  return {
    processFrigateDetection,
    processDetectionWithCooldown,
    processCheckInEvent,
    processFrigateEvent,
    refreshExpiredPlateStates,
    releasePlateAssignment(plate) {
      return database.releasePlateAssignment(normalizePlate(plate));
    },
  };
}

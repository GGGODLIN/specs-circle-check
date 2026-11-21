import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BLIND_SPOT_ZONE_IDS,
  DEFAULT_VEHICLE_GEOMETRY_SPEC,
  createCameraPoseLookAt,
  createInitialState,
  horizontalDistXZ,
  isInDriverSeat,
  isLineOfSightClear,
  isPointInForwardFrustum,
  isTricycleOutsideDangerLane,
  step,
  traceSightline,
  worldToCameraLocal,
  type BlindSpotZoneId,
  type CameraPose,
  type CircleCheckAction,
  type CircleCheckState,
  type Vec2XZ,
  type Vec3,
  type VehicleGeometrySpec
} from "../Assets/Scripts/Core/CircleCheckCore";

// Test-only yaw/pitch pose helper for PBT applicability domain sampling (not exported by production Core).
function createCameraPoseFromYawPitch(
  position: Vec3,
  yawDeg: number,
  pitchDeg: number
): CameraPose {
  const degToRad = Math.PI / 180;
  const yaw = yawDeg * degToRad;
  const pitch = pitchDeg * degToRad;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  const forward: Vec3 = {
    x: -sinYaw * cosPitch,
    y: sinPitch,
    z: -cosYaw * cosPitch
  };
  const right: Vec3 = {
    x: cosYaw,
    y: 0,
    z: -sinYaw
  };
  const up: Vec3 = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x
  };

  return { position, forward, right, up };
}

// ============================================================================
// Pure Invariant Checkers (shared by Role 2 PBT and Role 3 Oracle Calibration)
// ============================================================================

function checkP1Reciprocity(
  losFn: (a: Vec3, b: Vec3) => boolean,
  a: Vec3,
  b: Vec3
): boolean {
  return losFn(a, b) === losFn(b, a);
}

interface IndependentOracle {
  readonly clearedActive: boolean;
}

function createInitialOracle(): IndependentOracle {
  return { clearedActive: false };
}

function oracleInDangerLane(s: VehicleGeometrySpec, pos: Vec2XZ): boolean {
  const { minX, maxX, minZ, maxZ } = s.tricycle.dangerLane;
  return pos.x >= minX && pos.x <= maxX && pos.z >= minZ && pos.z <= maxZ;
}

function oracleInDriverSeat(s: VehicleGeometrySpec, camPos: Vec3): boolean {
  const dx = camPos.x - s.driverEyeLocalPos.x;
  const dz = camPos.z - s.driverEyeLocalPos.z;
  return (
    Math.hypot(dx, dz) <= s.driverSeatHorizontalRadiusCm &&
    Math.abs(camPos.y - s.driverEyeLocalPos.y) <= s.driverSeatVerticalToleranceCm
  );
}

interface P3CheckResult {
  readonly ok: boolean;
  readonly nextOracle: IndependentOracle;
}

function checkP3DepartureOracleStep(
  prevState: CircleCheckState,
  action: CircleCheckAction,
  nextState: CircleCheckState,
  oracle: IndependentOracle
): P3CheckResult {
  const s = prevState.spec;
  let nextClearedActive = oracle.clearedActive;
  let dragGuardOk = true;
  let expectedReject: "OUT_OF_REACH" | "OCCLUDED_BY_VEHICLE" | "NOT_IN_DRIVER_SEAT" | null | undefined =
    undefined;

  switch (action.type) {
    case "MoveCamera": {
      if (!oracleInDriverSeat(s, action.pose.position)) {
        nextClearedActive = false;
      }
      break;
    }
    case "DragTricycle": {
      const distXZ = Math.hypot(
        prevState.cameraPose.position.x - prevState.tricyclePos.x,
        prevState.cameraPose.position.z - prevState.tricyclePos.z
      );
      if (distXZ > s.tricycle.maxReachDistanceCm) {
        expectedReject = "OUT_OF_REACH";
        dragGuardOk =
          nextState.tricyclePos.x === prevState.tricyclePos.x &&
          nextState.tricyclePos.y === prevState.tricyclePos.y &&
          nextState.tricyclePos.z === prevState.tricyclePos.z;
      } else if (
        !isLineOfSightClear(s, prevState.cameraPose.position, {
          x: prevState.tricyclePos.x,
          y: s.tricycle.rayTargetYCm,
          z: prevState.tricyclePos.z
        })
      ) {
        expectedReject = "OCCLUDED_BY_VEHICLE";
        dragGuardOk =
          nextState.tricyclePos.x === prevState.tricyclePos.x &&
          nextState.tricyclePos.y === prevState.tricyclePos.y &&
          nextState.tricyclePos.z === prevState.tricyclePos.z;
      } else {
        expectedReject = null;
        const { dragBounds, keepoutBox } = s.tricycle;
        const withinBounds =
          nextState.tricyclePos.y === 0 &&
          nextState.tricyclePos.x >= dragBounds.minX &&
          nextState.tricyclePos.x <= dragBounds.maxX &&
          nextState.tricyclePos.z >= dragBounds.minZ &&
          nextState.tricyclePos.z <= dragBounds.maxZ;
        const outsideKeepout = !(
          nextState.tricyclePos.x >= keepoutBox.minX &&
          nextState.tricyclePos.x <= keepoutBox.maxX &&
          nextState.tricyclePos.z >= keepoutBox.minZ &&
          nextState.tricyclePos.z <= keepoutBox.maxZ
        );
        dragGuardOk = withinBounds && outsideKeepout;
        if (oracleInDangerLane(s, nextState.tricyclePos)) {
          nextClearedActive = false;
        }
      }
      break;
    }
    case "PressReadyToDepart": {
      const inSeat = oracleInDriverSeat(s, prevState.cameraPose.position);
      if (!inSeat) {
        nextClearedActive = false;
        expectedReject = "NOT_IN_DRIVER_SEAT";
      } else {
        const trikeCleared = !oracleInDangerLane(s, prevState.tricyclePos);
        nextClearedActive = inSeat && prevState.allZonesVerified && trikeCleared;
        expectedReject = null;
      }
      break;
    }
    case "Reset": {
      nextClearedActive = false;
      expectedReject = null;
      break;
    }
  }

  const nextOracle: IndependentOracle = { clearedActive: nextClearedActive };

  // Evaluate every sub-invariant without short-circuit masking.
  const expectedInSeat = oracleInDriverSeat(s, nextState.cameraPose.position);
  const expectedTrikeCleared = !oracleInDangerLane(s, nextState.tricyclePos);
  const expectedCanDepart = expectedInSeat && nextState.allZonesVerified && expectedTrikeCleared;

  const clearedMatchesOracle = (nextState.departureStatus === "CLEARED") === nextClearedActive;
  const inSeatMatches = nextState.inDriverSeat === expectedInSeat;
  const trikeClearedMatches = nextState.isTricycleCleared === expectedTrikeCleared;
  const canDepartMatches = nextState.canDepart === expectedCanDepart;
  const rejectMatches =
    expectedReject === undefined ? true : nextState.lastRejectReason === expectedReject;

  const resetClean =
    action.type !== "Reset"
      ? true
      : !nextState.allZonesVerified &&
        nextState.departureStatus === "IDLE" &&
        nextState.tricyclePos.x === s.tricycle.initialPos.x &&
        nextState.tricyclePos.y === 0 &&
        nextState.tricyclePos.z === s.tricycle.initialPos.z &&
        nextState.cellInspected.every((v) => v === false);

  const clearedSafety =
    nextState.departureStatus !== "CLEARED"
      ? true
      : nextState.inDriverSeat && nextState.allZonesVerified && nextState.isTricycleCleared;

  const ok =
    dragGuardOk &&
    clearedMatchesOracle &&
    inSeatMatches &&
    trikeClearedMatches &&
    canDepartMatches &&
    rejectMatches &&
    resetClean &&
    clearedSafety;

  return { ok, nextOracle };
}

function checkP4FrustumAndOcclusionStep(
  prevState: CircleCheckState,
  pose: CameraPose,
  nextState: CircleCheckState
): boolean {
  const s = prevState.spec;
  const inSeat = isInDriverSeat(s, pose.position);
  const distFromDriver = horizontalDistXZ(pose.position, s.driverEyeLocalPos);
  const canInspectAtAll = !inSeat && distFromDriver > s.walkaroundMinDriverDistCm;

  // Independently compute which previously-uninspected blind cells legitimately qualified on this pose.
  const directlyQualified = new Set<number>();
  if (canInspectAtAll) {
    for (const cell of prevState.footprint.cells) {
      if (cell.classification !== "Blind" || prevState.cellInspected[cell.index] === true) {
        continue;
      }
      const distToCell = horizontalDistXZ(pose.position, {
        x: cell.centerX,
        z: cell.centerZ
      });
      if (distToCell > s.frustum.maxInspectDistanceCm) {
        continue;
      }
      const floorPoint: Vec3 = {
        x: cell.centerX,
        y: s.footprint.floorSampleYCm,
        z: cell.centerZ
      };
      const local = worldToCameraLocal(pose, floorPoint);
      // Strict forward -Z requirement: camZ < 0 strictly (never Math.abs).
      if (local.z >= 0) {
        continue;
      }
      const depth = -local.z;
      if (
        Math.abs(local.x) / depth > s.frustum.tanHalfHorizontalFov ||
        Math.abs(local.y) / depth > s.frustum.tanHalfVerticalFov
      ) {
        continue;
      }
      if (!isLineOfSightClear(s, pose.position, floorPoint)) {
        continue;
      }
      directlyQualified.add(cell.index);
    }
  }

  // Determine which zones legitimately crossed >= 60% on this step.
  const thresholdPercent = Math.round(s.frustum.zoneVerifyThreshold * 100);
  const legitimatelyFlippedZones = new Set<BlindSpotZoneId>();
  for (const zone of BLIND_SPOT_ZONE_IDS) {
    if (prevState.zoneVerified[zone]) {
      continue;
    }
    const indices = prevState.footprint.zoneCellIndices[zone];
    let countAfterDirect = 0;
    for (const idx of indices) {
      if (prevState.cellInspected[idx] === true || directlyQualified.has(idx)) {
        countAfterDirect += 1;
      }
    }
    if (indices.length > 0 && countAfterDirect * 100 >= indices.length * thresholdPercent) {
      legitimatelyFlippedZones.add(zone);
    }
  }

  // Every cell that transitioned false -> true MUST either be directly qualified or belong to a newly >=60% flipped zone.
  for (const cell of prevState.footprint.cells) {
    const was = prevState.cellInspected[cell.index] === true;
    const now = nextState.cellInspected[cell.index] === true;
    if (!was && now) {
      if (cell.classification !== "Blind" || cell.zone === null) {
        return false;
      }
      const allowedByDirect = directlyQualified.has(cell.index);
      const allowedByZoneFlip = legitimatelyFlippedZones.has(cell.zone);
      if (!allowedByDirect && !allowedByZoneFlip) {
        return false;
      }
    }
  }

  // If 0 cells qualified directly, literally 0 cells may transition false -> true.
  if (directlyQualified.size === 0) {
    for (let i = 0; i < prevState.cellInspected.length; i += 1) {
      if (prevState.cellInspected[i] !== nextState.cellInspected[i]) {
        return false;
      }
    }
  }

  return true;
}

// ============================================================================
// fast-check Generators over the Spec Applicability Domain
// ============================================================================

const arbPointInDomain = fc.record({
  x: fc.double({ min: -300, max: 300, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: 40, max: 200, noNaN: true, noDefaultInfinity: true }),
  z: fc.double({ min: -300, max: 350, noNaN: true, noDefaultInfinity: true })
});

const arbRandomCameraPose = fc
  .record({
    position: arbPointInDomain,
    yawDeg: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    pitchDeg: fc.double({ min: -60, max: 60, noNaN: true, noDefaultInfinity: true })
  })
  .map(({ position, yawDeg, pitchDeg }) =>
    createCameraPoseFromYawPitch(position, yawDeg, pitchDeg)
  );

// Single canonical set of named walkaround & interaction vantage poses reused across generators and calibration.
const VANTAGES = {
  driverSeat: createCameraPoseLookAt(DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos, {
    x: -45,
    y: 152,
    z: 100
  }),
  walkaroundSweeps: [
    createCameraPoseLookAt({ x: -135, y: 165, z: 230 }, { x: -115, y: 2, z: 80 }),
    createCameraPoseLookAt({ x: -175, y: 155, z: 120 }, { x: -140, y: 2, z: 0 }),
    createCameraPoseLookAt({ x: -155, y: 160, z: 180 }, { x: -110, y: 2, z: 100 }),
    createCameraPoseLookAt({ x: 0, y: 165, z: 260 }, { x: 0, y: 2, z: 95 }),
    createCameraPoseLookAt({ x: 0, y: 160, z: 210 }, { x: 0, y: 2, z: 70 }),
    createCameraPoseLookAt({ x: 135, y: 165, z: 230 }, { x: 115, y: 2, z: 85 }),
    createCameraPoseLookAt({ x: 175, y: 155, z: 130 }, { x: 140, y: 2, z: 10 }),
    createCameraPoseLookAt({ x: 155, y: 160, z: 190 }, { x: 120, y: 2, z: 100 })
  ] as readonly CameraPose[],
  nearInitialTrike: createCameraPoseLookAt({ x: 20, y: 140, z: 120 }, { x: 15, y: 25, z: 55 }),
  occludedBehindBumper: createCameraPoseLookAt({ x: 15, y: 90, z: -50 }, { x: 15, y: 25, z: 55 }),
  nearSafeRing: createCameraPoseLookAt({ x: 140, y: 140, z: 120 }, { x: 150, y: 25, z: 70 })
} as const;

const ALL_VANTAGE_POSES: readonly CameraPose[] = [
  VANTAGES.driverSeat,
  ...VANTAGES.walkaroundSweeps,
  VANTAGES.nearInitialTrike,
  VANTAGES.occludedBehindBumper,
  VANTAGES.nearSafeRing
];

const arbTricycleTargetXZ = fc.record({
  x: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  z: fc.double({ min: 5, max: 300, noNaN: true, noDefaultInfinity: true })
});

const arbSingleAction: fc.Arbitrary<CircleCheckAction> = fc.oneof(
  {
    weight: 4,
    arbitrary: arbRandomCameraPose.map((pose): CircleCheckAction => ({ type: "MoveCamera", pose }))
  },
  {
    weight: 4,
    arbitrary: fc
      .constantFrom(...ALL_VANTAGE_POSES)
      .map((pose): CircleCheckAction => ({ type: "MoveCamera", pose }))
  },
  {
    weight: 3,
    arbitrary: fc
      .oneof(
        arbTricycleTargetXZ,
        fc.constant({ x: 150, z: 70 }),
        fc.constant({ x: 15, z: 55 })
      )
      .map((targetXZ): CircleCheckAction => ({ type: "DragTricycle", targetXZ }))
  },
  {
    weight: 3,
    arbitrary: fc.constant<CircleCheckAction>({ type: "PressReadyToDepart" })
  },
  {
    weight: 1,
    arbitrary: fc.constant<CircleCheckAction>({ type: "Reset" })
  }
);

// Mix arbitrary single actions with realistic multi-step user chunks (flattened to individual public
// CircleCheckActions) so random sequences reach both blocked and cleared/reverted paths without vacuity.
const arbActionChunk: fc.Arbitrary<readonly CircleCheckAction[]> = fc.oneof(
  {
    weight: 10,
    arbitrary: arbSingleAction.map((action) => [action])
  },
  {
    weight: 2,
    arbitrary: fc.constant<readonly CircleCheckAction[]>(
      VANTAGES.walkaroundSweeps.map((pose) => ({ type: "MoveCamera", pose }))
    )
  },
  {
    weight: 2,
    arbitrary: fc.constant<readonly CircleCheckAction[]>([
      { type: "MoveCamera", pose: VANTAGES.nearInitialTrike },
      { type: "DragTricycle", targetXZ: { x: 150, z: 70 } }
    ])
  },
  {
    weight: 1,
    arbitrary: fc.constant<readonly CircleCheckAction[]>([
      { type: "MoveCamera", pose: VANTAGES.nearSafeRing },
      { type: "DragTricycle", targetXZ: { x: 15, z: 55 } }
    ])
  },
  {
    weight: 2,
    arbitrary: fc.constant<readonly CircleCheckAction[]>([
      { type: "MoveCamera", pose: VANTAGES.driverSeat },
      { type: "PressReadyToDepart" }
    ])
  }
);

const arbActionSequence: fc.Arbitrary<readonly CircleCheckAction[]> = fc
  .array(arbActionChunk, { minLength: 8, maxLength: 24 })
  .map((chunks) => chunks.flat());

// ============================================================================
// Role 2: fast-check Conditional PBT Guardians (P1, P3, P4)
// ============================================================================

describe("Role 2 — fast-check Conditional PBT Safety Guardians", () => {
  it("P1: sightline reciprocity symmetry holds across random 3D point pairs in applicability domain", () => {
    let clearPairCount = 0;
    let blockedPairCount = 0;

    fc.assert(
      fc.property(arbPointInDomain, arbPointInDomain, (a, b) => {
        const abTrace = traceSightline(DEFAULT_VEHICLE_GEOMETRY_SPEC, a, b);
        const baTrace = traceSightline(DEFAULT_VEHICLE_GEOMETRY_SPEC, b, a);
        const abClear = isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, a, b);
        const baClear = isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, b, a);

        if (abClear) {
          clearPairCount += 1;
        } else {
          blockedPairCount += 1;
        }

        return (
          checkP1Reciprocity(
            (p, q) => isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, p, q),
            a,
            b
          ) &&
          abTrace.clear === abClear &&
          baTrace.clear === baClear
        );
      }),
      { numRuns: 1000, seed: 20261121 }
    );

    // Aggregate reachability witnesses verified AFTER fc.assert completes.
    expect(clearPairCount).toBeGreaterThan(0);
    expect(blockedPairCount).toBeGreaterThan(0);
  });

  it("P3 & P4: Independent Oracle verifies zero false departure clearance, drag guards, and frustum honesty across random action sequences", () => {
    let blockedCount = 0;
    let clearedCount = 0;
    let revertedFromClearedCount = 0;
    let rejectedOutOfReachCount = 0;
    let rejectedOccludedCount = 0;
    let acceptedDragCount = 0;
    let resetCount = 0;

    fc.assert(
      fc.property(arbActionSequence, (actions) => {
        let state = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);
        let oracle = createInitialOracle();

        for (const action of actions) {
          const prevStatus = state.departureStatus;
          const nextState = step(state, action);

          const p3 = checkP3DepartureOracleStep(state, action, nextState, oracle);
          const p4Ok =
            action.type === "MoveCamera"
              ? checkP4FrustumAndOcclusionStep(state, action.pose, nextState)
              : true;

          if (!p3.ok || !p4Ok) {
            return false;
          }

          if (action.type === "PressReadyToDepart") {
            if (nextState.departureStatus === "BLOCKED") {
              blockedCount += 1;
            } else if (nextState.departureStatus === "CLEARED") {
              clearedCount += 1;
            }
          } else if (action.type === "DragTricycle") {
            if (nextState.lastRejectReason === "OUT_OF_REACH") {
              rejectedOutOfReachCount += 1;
            } else if (nextState.lastRejectReason === "OCCLUDED_BY_VEHICLE") {
              rejectedOccludedCount += 1;
            } else if (nextState.lastRejectReason === null) {
              acceptedDragCount += 1;
            }
          } else if (action.type === "Reset") {
            resetCount += 1;
          }

          if (prevStatus === "CLEARED" && nextState.departureStatus === "IDLE") {
            revertedFromClearedCount += 1;
          }

          state = nextState;
          oracle = p3.nextOracle;
        }

        return true;
      }),
      { numRuns: 250, seed: 20261122 }
    );

    // Aggregate reachability witnesses verified AFTER fc.assert completes.
    expect(blockedCount).toBeGreaterThan(0);
    expect(clearedCount).toBeGreaterThan(0);
    expect(revertedFromClearedCount).toBeGreaterThan(0);
    expect(rejectedOutOfReachCount).toBeGreaterThan(0);
    expect(rejectedOccludedCount).toBeGreaterThan(0);
    expect(acceptedDragCount).toBeGreaterThan(0);
    expect(resetCount).toBeGreaterThan(0);
  });

  it("P4: camera poses facing away (camZ >= 0 for all blind cells) or fully occluded flip literally 0 cells", () => {
    let awayPoseCount = 0;
    let occludedPoseCount = 0;

    // Facing strictly +Z (yaw ~ 180) from ahead of the blind footprint (z >= 215) places every blind cell at camZ >= 0.
    const arbFacingAwayPose = fc
      .record({
        x: fc.double({ min: -250, max: 250, noNaN: true, noDefaultInfinity: true }),
        y: fc.double({ min: 60, max: 190, noNaN: true, noDefaultInfinity: true }),
        z: fc.double({ min: 215, max: 350, noNaN: true, noDefaultInfinity: true }),
        yawDeg: fc.double({ min: 150, max: 210, noNaN: true, noDefaultInfinity: true }),
        pitchDeg: fc.double({ min: -15, max: 45, noNaN: true, noDefaultInfinity: true })
      })
      .map(({ x, y, z, yawDeg, pitchDeg }) =>
        createCameraPoseFromYawPitch({ x, y, z }, yawDeg, pitchDeg)
      );

    // Poses behind the firewall looking forward through the engine block.
    const arbOccludedPose = fc
      .record({
        x: fc.double({ min: -80, max: 80, noNaN: true, noDefaultInfinity: true }),
        y: fc.double({ min: 40, max: 110, noNaN: true, noDefaultInfinity: true }),
        z: fc.double({ min: -260, max: -165, noNaN: true, noDefaultInfinity: true }),
        targetX: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
        targetZ: fc.double({ min: 10, max: 180, noNaN: true, noDefaultInfinity: true })
      })
      .map(({ x, y, z, targetX, targetZ }) =>
        createCameraPoseLookAt({ x, y, z }, { x: targetX, y: 2, z: targetZ })
      );

    const baseState = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);

    fc.assert(
      fc.property(arbFacingAwayPose, (pose) => {
        const allBehindOrPerp = baseState.footprint.cells.every((cell) => {
          if (cell.classification !== "Blind") {
            return true;
          }
          const local = worldToCameraLocal(pose, {
            x: cell.centerX,
            y: DEFAULT_VEHICLE_GEOMETRY_SPEC.footprint.floorSampleYCm,
            z: cell.centerZ
          });
          return local.z >= 0;
        });
        if (!allBehindOrPerp) {
          return true;
        }
        awayPoseCount += 1;
        const next = step(baseState, { type: "MoveCamera", pose });
        const flippedCount = next.cellInspected.filter(Boolean).length;
        return flippedCount === 0 && checkP4FrustumAndOcclusionStep(baseState, pose, next);
      }),
      { numRuns: 300, seed: 20261123 }
    );

    fc.assert(
      fc.property(arbOccludedPose, (pose) => {
        const allOccluded = baseState.footprint.cells.every((cell) => {
          if (cell.classification !== "Blind") {
            return true;
          }
          const floorPoint: Vec3 = {
            x: cell.centerX,
            y: DEFAULT_VEHICLE_GEOMETRY_SPEC.footprint.floorSampleYCm,
            z: cell.centerZ
          };
          if (!isPointInForwardFrustum(DEFAULT_VEHICLE_GEOMETRY_SPEC, pose, floorPoint)) {
            return true;
          }
          return !isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, pose.position, floorPoint);
        });
        if (!allOccluded) {
          return true;
        }
        occludedPoseCount += 1;
        const next = step(baseState, { type: "MoveCamera", pose });
        const flippedCount = next.cellInspected.filter(Boolean).length;
        return flippedCount === 0 && checkP4FrustumAndOcclusionStep(baseState, pose, next);
      }),
      { numRuns: 300, seed: 20261124 }
    );

    expect(awayPoseCount).toBeGreaterThan(50);
    expect(occludedPoseCount).toBeGreaterThan(50);
  });
});

// ============================================================================
// Role 3: Oracle Calibration Controls (test-local known-bad mutations)
// ============================================================================

describe("Role 3 — Oracle Calibration Controls (known-bad mutation traps)", () => {
  it("P1 calibration catches an asymmetric line-of-sight implementation", () => {
    const faultyAsymmetricLos = (a: Vec3, b: Vec3): boolean => {
      if (a.z > b.z) {
        return true;
      }
      return isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, a, b);
    };

    const driverEye = DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos;
    const toddlerPos: Vec3 = { x: -45, y: 70, z: 100 };

    expect(
      checkP1Reciprocity(
        (a, b) => isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, a, b),
        driverEye,
        toddlerPos
      )
    ).toBe(true);
    expect(checkP1Reciprocity(faultyAsymmetricLos, driverEye, toddlerPos)).toBe(false);
  });

  it("P3 calibration catches false CLEARED, stale CLEARED after seat exit, and bypassed drag guards", () => {
    const initialInSeat = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC, VANTAGES.driverSeat);
    const initialOracle = createInitialOracle();

    // 3a. Mutated false CLEARED when zones & tricycle are NOT cleared
    const legitimateBlocked = step(initialInSeat, { type: "PressReadyToDepart" });
    const mutatedFalseCleared: CircleCheckState = {
      ...legitimateBlocked,
      departureStatus: "CLEARED"
    };
    expect(
      checkP3DepartureOracleStep(
        initialInSeat,
        { type: "PressReadyToDepart" },
        mutatedFalseCleared,
        initialOracle
      ).ok
    ).toBe(false);

    // 3b. Mutated stale CLEARED surviving driver-seat exit
    let state = initialInSeat;
    let oracle = initialOracle;
    for (const pose of VANTAGES.walkaroundSweeps) {
      const action: CircleCheckAction = { type: "MoveCamera", pose };
      const next = step(state, action);
      const check = checkP3DepartureOracleStep(state, action, next, oracle);
      expect(check.ok).toBe(true);
      state = next;
      oracle = check.nextOracle;
    }
    const setupActions: readonly CircleCheckAction[] = [
      { type: "MoveCamera", pose: VANTAGES.nearInitialTrike },
      { type: "DragTricycle", targetXZ: { x: 150, z: 70 } },
      { type: "MoveCamera", pose: VANTAGES.driverSeat },
      { type: "PressReadyToDepart" }
    ];
    for (const action of setupActions) {
      const next = step(state, action);
      const check = checkP3DepartureOracleStep(state, action, next, oracle);
      expect(check.ok).toBe(true);
      state = next;
      oracle = check.nextOracle;
    }
    expect(state.departureStatus).toBe("CLEARED");

    const exitSeatAction: CircleCheckAction = {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: -140, y: 150, z: 80 }, { x: 0, y: 2, z: 80 })
    };
    const legitimateExit = step(state, exitSeatAction);
    const mutatedStaleCleared: CircleCheckState = {
      ...legitimateExit,
      departureStatus: "CLEARED"
    };
    expect(checkP3DepartureOracleStep(state, exitSeatAction, legitimateExit, oracle).ok).toBe(true);
    expect(checkP3DepartureOracleStep(state, exitSeatAction, mutatedStaleCleared, oracle).ok).toBe(
      false
    );

    // 3c. Mutated bypassed through-hood drag guard from driver seat
    const badDragAction: CircleCheckAction = {
      type: "DragTricycle",
      targetXZ: { x: 150, z: 70 }
    };
    const legitimateReject = step(initialInSeat, badDragAction);
    const mutatedMovedTrike: CircleCheckState = {
      ...legitimateReject,
      tricyclePos: { x: 150, y: 0, z: 70 },
      isTricycleCleared: isTricycleOutsideDangerLane(DEFAULT_VEHICLE_GEOMETRY_SPEC, {
        x: 150,
        z: 70
      }),
      lastRejectReason: null
    };
    expect(
      checkP3DepartureOracleStep(initialInSeat, badDragAction, legitimateReject, initialOracle).ok
    ).toBe(true);
    expect(
      checkP3DepartureOracleStep(initialInSeat, badDragAction, mutatedMovedTrike, initialOracle).ok
    ).toBe(false);
  });

  it("P4 calibration catches back-facing Math.abs(dot) cell flips and occluded cell flips", () => {
    const baseState = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);
    const firstBlindCell = baseState.footprint.cells.find((c) => c.classification === "Blind");
    expect(firstBlindCell).toBeDefined();
    if (firstBlindCell === undefined) {
      return;
    }

    // 4a. Back-facing pose (camZ >= 0) with mutated cell flip (simulating Round 1 Math.abs(dot) bug)
    const awayPose = createCameraPoseFromYawPitch({ x: 0, y: 150, z: 240 }, 180, 0);
    const legitimateAway = step(baseState, { type: "MoveCamera", pose: awayPose });
    const mutatedAwayInspected = legitimateAway.cellInspected.slice();
    mutatedAwayInspected[firstBlindCell.index] = true;
    const mutatedAwayState: CircleCheckState = {
      ...legitimateAway,
      cellInspected: mutatedAwayInspected
    };
    expect(checkP4FrustumAndOcclusionStep(baseState, awayPose, legitimateAway)).toBe(true);
    expect(checkP4FrustumAndOcclusionStep(baseState, awayPose, mutatedAwayState)).toBe(false);

    // 4b. Occluded pose behind firewall looking through bumper with mutated cell flip
    const occludedPose = createCameraPoseLookAt(
      { x: 15, y: 90, z: -180 },
      { x: 15, y: 2, z: 60 }
    );
    const legitimateOccluded = step(baseState, { type: "MoveCamera", pose: occludedPose });
    const mutatedOccludedInspected = legitimateOccluded.cellInspected.slice();
    mutatedOccludedInspected[firstBlindCell.index] = true;
    const mutatedOccludedState: CircleCheckState = {
      ...legitimateOccluded,
      cellInspected: mutatedOccludedInspected
    };
    expect(checkP4FrustumAndOcclusionStep(baseState, occludedPose, legitimateOccluded)).toBe(true);
    expect(checkP4FrustumAndOcclusionStep(baseState, occludedPose, mutatedOccludedState)).toBe(false);
  });
});

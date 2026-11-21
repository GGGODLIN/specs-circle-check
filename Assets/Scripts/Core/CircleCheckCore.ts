import {
  BLIND_SPOT_ZONE_IDS,
  DEFAULT_VEHICLE_GEOMETRY_SPEC,
  classifyFootprintCells,
  horizontalDistXZ,
  isLineOfSightClear,
  traceSightline,
  type BlindSpotZoneId,
  type FootprintClassification,
  type SightlineTraceResult,
  type Vec2XZ,
  type Vec3,
  type VehicleGeometrySpec
} from "./VehicleGeometrySpec";

export {
  BLIND_SPOT_ZONE_IDS,
  DEFAULT_VEHICLE_GEOMETRY_SPEC,
  classifyFootprintCells,
  horizontalDistXZ,
  isLineOfSightClear,
  traceSightline
};

export type {
  BlindSpotZoneId,
  FootprintClassification,
  SightlineTraceResult,
  Vec2XZ,
  Vec3,
  VehicleGeometrySpec
};

export interface CameraPose {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

export type DepartureStatus = "IDLE" | "BLOCKED" | "CLEARED";

export type RejectReason =
  | "OUT_OF_REACH"
  | "OCCLUDED_BY_VEHICLE"
  | "NOT_IN_DRIVER_SEAT"
  | null;

export type CircleCheckAction =
  | { readonly type: "MoveCamera"; readonly pose: CameraPose }
  | { readonly type: "DragTricycle"; readonly targetXZ: Vec2XZ }
  | { readonly type: "PressReadyToDepart" }
  | { readonly type: "Reset"; readonly cameraPose?: CameraPose };

export interface CircleCheckState {
  readonly spec: VehicleGeometrySpec;
  readonly footprint: FootprintClassification;
  readonly cameraPose: CameraPose;
  readonly inDriverSeat: boolean;
  readonly sightline: SightlineTraceResult;
  readonly cellInspected: readonly boolean[];
  readonly zoneVerified: Readonly<Record<BlindSpotZoneId, boolean>>;
  readonly allZonesVerified: boolean;
  readonly tricyclePos: Vec3;
  readonly isTricycleCleared: boolean;
  readonly canDepart: boolean;
  readonly departureStatus: DepartureStatus;
  readonly lastRejectReason: RejectReason;
  readonly walkaroundBeaconsActive: boolean;
}

export interface DebugSnapshot {
  readonly inDriverSeat: boolean;
  readonly sightlineBlocked: boolean;
  readonly sightlineHitPoint: Vec3 | null;
  readonly sightlineHitOccluderId: string | null;
  readonly zoneVerified: Readonly<Record<BlindSpotZoneId, boolean>>;
  readonly zoneCoverage: Readonly<Record<BlindSpotZoneId, number>>;
  readonly allZonesVerified: boolean;
  readonly tricyclePos: Vec3;
  readonly isTricycleCleared: boolean;
  readonly canDepart: boolean;
  readonly departureStatus: DepartureStatus;
  readonly lastRejectReason: RejectReason;
  readonly walkaroundBeaconsActive: boolean;
  readonly cameraPos: Vec3;
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.sqrt(dotVec3(v, v));
  if (len === 0) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function createCameraPoseLookAt(
  position: Vec3,
  target: Vec3,
  worldUp: Vec3 = { x: 0, y: 1, z: 0 }
): CameraPose {
  const forward = normalizeVec3({
    x: target.x - position.x,
    y: target.y - position.y,
    z: target.z - position.z
  });

  const upRef =
    Math.abs(dotVec3(forward, normalizeVec3(worldUp))) > 0.999
      ? { x: 0, y: 0, z: -1 }
      : worldUp;

  const right = normalizeVec3(crossVec3(forward, upRef));
  const up = normalizeVec3(crossVec3(right, forward));

  return {
    position: { x: position.x, y: position.y, z: position.z },
    forward,
    right,
    up
  };
}

export function worldToCameraLocal(pose: CameraPose, point: Vec3): Vec3 {
  const dx = point.x - pose.position.x;
  const dy = point.y - pose.position.y;
  const dz = point.z - pose.position.z;
  const delta: Vec3 = { x: dx, y: dy, z: dz };

  const forward = normalizeVec3(pose.forward);
  const right = normalizeVec3(pose.right);
  const up = normalizeVec3(pose.up);

  return {
    x: dotVec3(delta, right),
    y: dotVec3(delta, up),
    // Negative forward projection matches camera -Z forward convention.
    z: -dotVec3(delta, forward)
  };
}

export function isPointInForwardFrustum(
  spec: VehicleGeometrySpec,
  pose: CameraPose,
  point: Vec3
): boolean {
  const local = worldToCameraLocal(pose, point);
  if (local.z >= 0) {
    return false;
  }

  const depth = -local.z;
  const horizontalRatio = Math.abs(local.x) / depth;
  const verticalRatio = Math.abs(local.y) / depth;

  return (
    horizontalRatio <= spec.frustum.tanHalfHorizontalFov &&
    verticalRatio <= spec.frustum.tanHalfVerticalFov
  );
}

export function isInDriverSeat(spec: VehicleGeometrySpec, camPos: Vec3): boolean {
  const distXZ = horizontalDistXZ(camPos, spec.driverEyeLocalPos);
  const deltaY = Math.abs(camPos.y - spec.driverEyeLocalPos.y);
  return (
    distXZ <= spec.driverSeatHorizontalRadiusCm &&
    deltaY <= spec.driverSeatVerticalToleranceCm
  );
}

export function isTricycleOutsideDangerLane(
  spec: VehicleGeometrySpec,
  pos: Vec2XZ
): boolean {
  const { minX, maxX, minZ, maxZ } = spec.tricycle.dangerLane;
  const inDangerLane =
    pos.x >= minX && pos.x <= maxX && pos.z >= minZ && pos.z <= maxZ;
  return !inDangerLane;
}

export function computeZoneCoverage(
  footprint: FootprintClassification,
  cellInspected: readonly boolean[]
): Readonly<Record<BlindSpotZoneId, number>> {
  const coverage = (zone: BlindSpotZoneId): number => {
    const indices = footprint.zoneCellIndices[zone];
    if (indices.length === 0) {
      return 1;
    }
    let inspectedCount = 0;
    for (const idx of indices) {
      if (cellInspected[idx] === true) {
        inspectedCount += 1;
      }
    }
    return inspectedCount / indices.length;
  };

  return {
    FrontLeftAPillar: coverage("FrontLeftAPillar"),
    FrontCenterHood: coverage("FrontCenterHood"),
    FrontRightAPillar: coverage("FrontRightAPillar")
  };
}

function deriveZoneState(
  spec: VehicleGeometrySpec,
  footprint: FootprintClassification,
  cellInspected: readonly boolean[]
): {
  readonly cellInspected: readonly boolean[];
  readonly zoneVerified: Readonly<Record<BlindSpotZoneId, boolean>>;
  readonly allZonesVerified: boolean;
} {
  const nextInspected = cellInspected.slice();
  const thresholdPercent = Math.round(spec.frustum.zoneVerifyThreshold * 100);
  const verified: Record<BlindSpotZoneId, boolean> = {
    FrontLeftAPillar: false,
    FrontCenterHood: false,
    FrontRightAPillar: false
  };

  for (const zone of BLIND_SPOT_ZONE_IDS) {
    const indices = footprint.zoneCellIndices[zone];
    let inspectedCount = 0;
    for (const idx of indices) {
      if (nextInspected[idx] === true) {
        inspectedCount += 1;
      }
    }
    // Exact integer comparison avoids floating-point drift at exact 60% boundaries.
    const isVerified =
      indices.length > 0 && inspectedCount * 100 >= indices.length * thresholdPercent;
    verified[zone] = isVerified;
    if (isVerified) {
      for (const idx of indices) {
        nextInspected[idx] = true;
      }
    }
  }

  const allZonesVerified =
    verified.FrontLeftAPillar && verified.FrontCenterHood && verified.FrontRightAPillar;

  return {
    cellInspected: nextInspected,
    zoneVerified: verified,
    allZonesVerified
  };
}

function buildState(params: {
  readonly spec: VehicleGeometrySpec;
  readonly footprint: FootprintClassification;
  readonly cameraPose: CameraPose;
  readonly cellInspected: readonly boolean[];
  readonly tricyclePos: Vec3;
  readonly departureStatus: DepartureStatus;
  readonly lastRejectReason: RejectReason;
}): CircleCheckState {
  const { spec, footprint, cameraPose, tricyclePos, lastRejectReason } = params;
  const inDriverSeat = isInDriverSeat(spec, cameraPose.position);
  const sightline = traceSightline(spec, spec.driverEyeLocalPos, cameraPose.position);
  const zoneState = deriveZoneState(spec, footprint, params.cellInspected);
  const isTricycleCleared = isTricycleOutsideDangerLane(spec, tricyclePos);
  const canDepart = inDriverSeat && zoneState.allZonesVerified && isTricycleCleared;

  let departureStatus = params.departureStatus;
  if (departureStatus === "CLEARED" && (!inDriverSeat || !isTricycleCleared)) {
    departureStatus = "IDLE";
  }

  const walkaroundBeaconsActive =
    !zoneState.allZonesVerified && (!inDriverSeat || departureStatus === "BLOCKED");

  return {
    spec,
    footprint,
    cameraPose,
    inDriverSeat,
    sightline,
    cellInspected: zoneState.cellInspected,
    zoneVerified: zoneState.zoneVerified,
    allZonesVerified: zoneState.allZonesVerified,
    tricyclePos,
    isTricycleCleared,
    canDepart,
    departureStatus,
    lastRejectReason,
    walkaroundBeaconsActive
  };
}

function clampAndSnapTricycleTarget(spec: VehicleGeometrySpec, targetXZ: Vec2XZ): Vec3 {
  const { dragBounds, keepoutBox, safeParkingRing } = spec.tricycle;
  const clampedX = Math.min(dragBounds.maxX, Math.max(dragBounds.minX, targetXZ.x));
  let clampedZ = Math.min(dragBounds.maxZ, Math.max(dragBounds.minZ, targetXZ.z));

  const insideKeepout =
    clampedX >= keepoutBox.minX &&
    clampedX <= keepoutBox.maxX &&
    clampedZ >= keepoutBox.minZ &&
    clampedZ <= keepoutBox.maxZ;

  if (insideKeepout) {
    // Keepout front edge sits at z = 5; pushing to z = 6 keeps the tricycle strictly outside the bumper box.
    clampedZ = keepoutBox.maxZ + 1;
  }

  const distToRing = horizontalDistXZ(
    { x: clampedX, z: clampedZ },
    safeParkingRing.center
  );
  if (
    clampedX > safeParkingRing.snapMinXCm ||
    distToRing <= safeParkingRing.snapDistanceCm
  ) {
    return {
      x: safeParkingRing.center.x,
      y: 0,
      z: safeParkingRing.center.z
    };
  }

  return { x: clampedX, y: 0, z: clampedZ };
}

export function createInitialState(
  spec: VehicleGeometrySpec = DEFAULT_VEHICLE_GEOMETRY_SPEC,
  initialCameraPose?: CameraPose
): CircleCheckState {
  const footprint = classifyFootprintCells(spec);
  const cameraPose =
    initialCameraPose ??
    createCameraPoseLookAt({ x: -45, y: 160, z: 100 }, spec.driverEyeLocalPos);
  const cellInspected = new Array<boolean>(footprint.cells.length).fill(false);

  return buildState({
    spec,
    footprint,
    cameraPose,
    cellInspected,
    tricyclePos: {
      x: spec.tricycle.initialPos.x,
      y: 0,
      z: spec.tricycle.initialPos.z
    },
    departureStatus: "IDLE",
    lastRejectReason: null
  });
}

function handleMoveCamera(state: CircleCheckState, pose: CameraPose): CircleCheckState {
  const { spec, footprint } = state;
  const inSeat = isInDriverSeat(spec, pose.position);
  const distFromDriverXZ = horizontalDistXZ(pose.position, spec.driverEyeLocalPos);
  const canInspect = !inSeat && distFromDriverXZ > spec.walkaroundMinDriverDistCm;

  const nextInspected = state.cellInspected.slice();

  if (canInspect) {
    for (const cell of footprint.cells) {
      if (cell.classification !== "Blind" || nextInspected[cell.index] === true) {
        continue;
      }

      const distToCellXZ = horizontalDistXZ(pose.position, {
        x: cell.centerX,
        z: cell.centerZ
      });
      if (distToCellXZ > spec.frustum.maxInspectDistanceCm) {
        continue;
      }

      const floorPoint: Vec3 = {
        x: cell.centerX,
        y: spec.footprint.floorSampleYCm,
        z: cell.centerZ
      };

      if (!isPointInForwardFrustum(spec, pose, floorPoint)) {
        continue;
      }

      if (!isLineOfSightClear(spec, pose.position, floorPoint)) {
        continue;
      }

      nextInspected[cell.index] = true;
    }
  }

  return buildState({
    spec,
    footprint,
    cameraPose: pose,
    cellInspected: nextInspected,
    tricyclePos: state.tricyclePos,
    departureStatus: state.departureStatus,
    lastRejectReason: state.lastRejectReason
  });
}

function handleDragTricycle(state: CircleCheckState, targetXZ: Vec2XZ): CircleCheckState {
  const { spec, footprint, cameraPose, tricyclePos } = state;

  const reachDistXZ = horizontalDistXZ(cameraPose.position, tricyclePos);
  if (reachDistXZ > spec.tricycle.maxReachDistanceCm) {
    return buildState({
      spec,
      footprint,
      cameraPose,
      cellInspected: state.cellInspected,
      tricyclePos,
      departureStatus: state.departureStatus,
      lastRejectReason: "OUT_OF_REACH"
    });
  }

  const trikeRayTarget: Vec3 = {
    x: tricyclePos.x,
    y: spec.tricycle.rayTargetYCm,
    z: tricyclePos.z
  };
  if (!isLineOfSightClear(spec, cameraPose.position, trikeRayTarget)) {
    return buildState({
      spec,
      footprint,
      cameraPose,
      cellInspected: state.cellInspected,
      tricyclePos,
      departureStatus: state.departureStatus,
      lastRejectReason: "OCCLUDED_BY_VEHICLE"
    });
  }

  const nextTrikePos = clampAndSnapTricycleTarget(spec, targetXZ);

  return buildState({
    spec,
    footprint,
    cameraPose,
    cellInspected: state.cellInspected,
    tricyclePos: nextTrikePos,
    departureStatus: state.departureStatus,
    lastRejectReason: null
  });
}

function handlePressReadyToDepart(state: CircleCheckState): CircleCheckState {
  if (!state.inDriverSeat) {
    return buildState({
      spec: state.spec,
      footprint: state.footprint,
      cameraPose: state.cameraPose,
      cellInspected: state.cellInspected,
      tricyclePos: state.tricyclePos,
      departureStatus: state.departureStatus,
      lastRejectReason: "NOT_IN_DRIVER_SEAT"
    });
  }

  const nextStatus: DepartureStatus = state.canDepart ? "CLEARED" : "BLOCKED";

  return buildState({
    spec: state.spec,
    footprint: state.footprint,
    cameraPose: state.cameraPose,
    cellInspected: state.cellInspected,
    tricyclePos: state.tricyclePos,
    departureStatus: nextStatus,
    lastRejectReason: null
  });
}

function handleReset(state: CircleCheckState, cameraPose?: CameraPose): CircleCheckState {
  const resetInspected = new Array<boolean>(state.footprint.cells.length).fill(false);

  return buildState({
    spec: state.spec,
    footprint: state.footprint,
    cameraPose: cameraPose ?? state.cameraPose,
    cellInspected: resetInspected,
    tricyclePos: {
      x: state.spec.tricycle.initialPos.x,
      y: 0,
      z: state.spec.tricycle.initialPos.z
    },
    departureStatus: "IDLE",
    lastRejectReason: null
  });
}

export function step(state: CircleCheckState, action: CircleCheckAction): CircleCheckState {
  switch (action.type) {
    case "MoveCamera":
      return handleMoveCamera(state, action.pose);
    case "DragTricycle":
      return handleDragTricycle(state, action.targetXZ);
    case "PressReadyToDepart":
      return handlePressReadyToDepart(state);
    case "Reset":
      return handleReset(state, action.cameraPose);
  }
}

export function getDebugSnapshot(state: CircleCheckState): DebugSnapshot {
  return {
    inDriverSeat: state.inDriverSeat,
    sightlineBlocked: !state.sightline.clear,
    sightlineHitPoint: state.sightline.hitPoint,
    sightlineHitOccluderId: state.sightline.hitOccluderId,
    zoneVerified: state.zoneVerified,
    zoneCoverage: computeZoneCoverage(state.footprint, state.cellInspected),
    allZonesVerified: state.allZonesVerified,
    tricyclePos: state.tricyclePos,
    isTricycleCleared: state.isTricycleCleared,
    canDepart: state.canDepart,
    departureStatus: state.departureStatus,
    lastRejectReason: state.lastRejectReason,
    walkaroundBeaconsActive: state.walkaroundBeaconsActive,
    cameraPos: state.cameraPose.position
  };
}

import { describe, expect, it } from "vitest";
import {
  BLIND_SPOT_ZONE_IDS,
  DEFAULT_VEHICLE_GEOMETRY_SPEC,
  classifyFootprintCells,
  createCameraPoseLookAt,
  createInitialState,
  getDebugSnapshot,
  isLineOfSightClear,
  step,
  traceSightline,
  type BlindSpotZoneId,
  type CircleCheckState,
  type Vec3
} from "../Assets/Scripts/Core/CircleCheckCore";

function sweepZoneFromOutside(state: CircleCheckState, zone: BlindSpotZoneId): CircleCheckState {
  const cellIndices = state.footprint.zoneCellIndices[zone];
  let current = state;

  for (const idx of cellIndices) {
    if (current.zoneVerified[zone]) {
      break;
    }
    const cell = current.footprint.cells[idx];
    if (cell === undefined) {
      continue;
    }
    const standPos: Vec3 = {
      x:
        cell.centerX < -100
          ? cell.centerX - 30
          : cell.centerX > 100
            ? cell.centerX + 30
            : cell.centerX,
      y: 155,
      z: cell.centerZ + 45
    };
    const pose = createCameraPoseLookAt(standPos, {
      x: cell.centerX,
      y: DEFAULT_VEHICLE_GEOMETRY_SPEC.footprint.floorSampleYCm,
      z: cell.centerZ
    });
    current = step(current, { type: "MoveCamera", pose });
  }

  return current;
}

describe("VehicleGeometrySpec — Single Immutable Source & Sightline Reciprocity", () => {
  it("exports frozen canonical 1:1 vehicle geometry and occluder face descriptors", () => {
    expect(Object.isFrozen(DEFAULT_VEHICLE_GEOMETRY_SPEC)).toBe(true);
    expect(Object.isFrozen(DEFAULT_VEHICLE_GEOMETRY_SPEC.occluders)).toBe(true);
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.vehicleWidthCm).toBe(200);
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.bumperHeightCm).toBe(112);
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.hoodRearHeightCm).toBe(118);
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.hoodRearZCm).toBe(-150);
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.aPillarTopHeightCm).toBe(172);
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.aPillarRearZCm).toBe(-185);
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos).toEqual({ x: -45, y: 152, z: -195 });
    expect(DEFAULT_VEHICLE_GEOMETRY_SPEC.dashboardStripLocalPos).toEqual({
      x: -45,
      y: 136,
      z: -152
    });

    const ids = new Set(DEFAULT_VEHICLE_GEOMETRY_SPEC.occluders.map((o) => o.id));
    expect(ids.has("front-bumper")).toBe(true);
    expect(ids.has("sloped-hood")).toBe(true);
    expect(ids.has("left-a-pillar")).toBe(true);
    expect(ids.has("right-a-pillar")).toBe(true);
    for (const occluder of DEFAULT_VEHICLE_GEOMETRY_SPEC.occluders) {
      expect(Object.isFrozen(occluder)).toBe(true);
      expect(occluder.quads.length).toBeGreaterThan(0);
    }
  });

  it("blocks 70 cm toddler height and clears 160 cm adult height at (-45, *, +100) around grazing y ≈ 91.5 cm", () => {
    const eye = DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos;

    const toddler = traceSightline(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: -45, y: 70, z: 100 });
    expect(toddler.clear).toBe(false);
    expect(toddler.hitPoint).not.toBeNull();
    expect(toddler.hitOccluderId).not.toBeNull();
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: -45, y: 70, z: 100 })).toBe(
      false
    );
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, { x: -45, y: 70, z: 100 }, eye)).toBe(
      false
    );

    // Grazing line over (y=112, z=0) from (-45,152,-195) hits z=+100 at y = 152 - 40*(295/195) ≈ 91.487 cm
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: -45, y: 91, z: 100 })).toBe(
      false
    );
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: -45, y: 92, z: 100 })).toBe(
      true
    );

    const adult = traceSightline(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: -45, y: 160, z: 100 });
    expect(adult.clear).toBe(true);
    expect(adult.hitPoint).toBeNull();
    expect(
      isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: -45, y: 160, z: 100 })
    ).toBe(true);
    expect(
      isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, { x: -45, y: 160, z: 100 }, eye)
    ).toBe(true);
  });

  it("occludes the initial 50 cm tricycle at (+15, 50, +55) around grazing y ≈ 100.7 cm", () => {
    const eye = DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos;

    // Grazing line over (y=112, z=0) hits z=+55 at y = 152 - 40*(250/195) ≈ 100.718 cm
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: 15, y: 50, z: 55 })).toBe(
      false
    );
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: 15, y: 25, z: 55 })).toBe(
      false
    );
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: 15, y: 100, z: 55 })).toBe(
      false
    );
    expect(isLineOfSightClear(DEFAULT_VEHICLE_GEOMETRY_SPEC, eye, { x: 15, y: 101, z: 55 })).toBe(
      true
    );
  });

  it("blocks diagonal sightlines passing through left and right A-pillar slabs", () => {
    const leftPillarMid: Vec3 = { x: -91, y: 145, z: -167.5 };
    const rightPillarMid: Vec3 = { x: 91, y: 145, z: -167.5 };

    expect(
      isLineOfSightClear(
        DEFAULT_VEHICLE_GEOMETRY_SPEC,
        { x: leftPillarMid.x, y: leftPillarMid.y, z: -210 },
        { x: leftPillarMid.x, y: leftPillarMid.y, z: -120 }
      )
    ).toBe(false);
    expect(
      isLineOfSightClear(
        DEFAULT_VEHICLE_GEOMETRY_SPEC,
        { x: rightPillarMid.x, y: rightPillarMid.y, z: -210 },
        { x: rightPillarMid.x, y: rightPillarMid.y, z: -120 }
      )
    ).toBe(false);
    // Center windshield remains open above the hood
    expect(
      isLineOfSightClear(
        DEFAULT_VEHICLE_GEOMETRY_SPEC,
        { x: 0, y: 145, z: -210 },
        { x: 0, y: 145, z: -120 }
      )
    ).toBe(true);
  });
});

describe("classifyFootprintCells — Boot-Time 18×18 3-Zone Footprint", () => {
  it("classifies 324 cells at 70 cm toddler height into 3 non-empty blind zones with < 1500 floor vertices", () => {
    const footprint = classifyFootprintCells(DEFAULT_VEHICLE_GEOMETRY_SPEC);

    expect(footprint.cells).toHaveLength(324);
    expect(footprint.blindCellCount).toBeGreaterThan(0);
    expect(footprint.estimatedFloorMeshVertices).toBe(footprint.blindCellCount * 4);
    expect(footprint.estimatedFloorMeshVertices).toBeLessThan(1500);

    let zoneTotal = 0;
    for (const zoneId of BLIND_SPOT_ZONE_IDS) {
      const indices = footprint.zoneCellIndices[zoneId];
      expect(indices.length).toBeGreaterThan(0);
      zoneTotal += indices.length;
    }
    expect(zoneTotal).toBe(footprint.blindCellCount);

    // Cells inside vehicle body [-100, +100] × [-220, 0] are excluded from walkable blind zones
    const bodyCells = footprint.cells.filter((c) => c.classification === "VehicleBody");
    expect(bodyCells.length).toBeGreaterThan(0);
    for (const c of bodyCells) {
      expect(c.zone).toBeNull();
    }
  });
});

describe("CircleCheckCore — Frustum Zone-Flip, Occlusion Honesty & Driver Seat", () => {
  it("flips 0 cells when camera faces away (camZ >= 0), is in driver seat, or looks through the hood", () => {
    const initial = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);

    // 1. Inside driver seat looking down at floor
    const inSeatPose = createCameraPoseLookAt(
      { x: -45, y: 152, z: -195 },
      { x: 0, y: 2, z: 80 }
    );
    const afterSeat = step(initial, { type: "MoveCamera", pose: inSeatPose });
    expect(afterSeat.inDriverSeat).toBe(true);
    expect(afterSeat.cellInspected.filter(Boolean)).toHaveLength(0);

    // 2. Outside at front-center, facing AWAY (+Z, so blind cells behind camera have camZ >= 0)
    const facingAwayPose = createCameraPoseLookAt({ x: 0, y: 150, z: 220 }, { x: 0, y: 132, z: 320 });
    const afterAway = step(afterSeat, { type: "MoveCamera", pose: facingAwayPose });
    expect(afterAway.inDriverSeat).toBe(false);
    expect(afterAway.cellInspected.filter(Boolean)).toHaveLength(0);

    // 3. Outside cab rear (>50 cm from driver eye), looking THROUGH hood/firewall toward front blind cells
    const behindFirewallPose = createCameraPoseLookAt(
      { x: 20, y: 140, z: -210 },
      { x: 20, y: 2, z: 50 }
    );
    const afterOccluded = step(afterAway, { type: "MoveCamera", pose: behindFirewallPose });
    expect(afterOccluded.inDriverSeat).toBe(false);
    expect(afterOccluded.cellInspected.filter(Boolean)).toHaveLength(0);
  });

  it("flips each zone to verified once unoccluded forward 37°×32° sweeps reach >= 60%", () => {
    let state = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);

    // Inspecting a small subset (< 60%) of FrontCenterHood leaves the zone unverified.
    const narrowPose = createCameraPoseLookAt({ x: 0, y: 120, z: 240 }, { x: 0, y: 2, z: 185 });
    const partial = step(state, { type: "MoveCamera", pose: narrowPose });
    const partialSnapshot = getDebugSnapshot(partial);
    expect(partialSnapshot.zoneCoverage.FrontCenterHood).toBeGreaterThan(0);
    expect(partialSnapshot.zoneCoverage.FrontCenterHood).toBeLessThan(0.6);
    expect(partial.zoneVerified.FrontCenterHood).toBe(false);

    state = sweepZoneFromOutside(partial, "FrontLeftAPillar");
    expect(state.zoneVerified.FrontLeftAPillar).toBe(true);
    expect(state.allZonesVerified).toBe(false);

    state = sweepZoneFromOutside(state, "FrontCenterHood");
    expect(state.zoneVerified.FrontCenterHood).toBe(true);
    expect(state.allZonesVerified).toBe(false);

    state = sweepZoneFromOutside(state, "FrontRightAPillar");
    expect(state.zoneVerified.FrontRightAPillar).toBe(true);
    expect(state.allZonesVerified).toBe(true);

    const snapshot = getDebugSnapshot(state);
    expect(snapshot.zoneCoverage.FrontLeftAPillar).toBe(1);
    expect(snapshot.zoneCoverage.FrontCenterHood).toBe(1);
    expect(snapshot.zoneCoverage.FrontRightAPillar).toBe(1);
  });
});

describe("CircleCheckCore — Tricycle Reach/Occlusion Guard, Safe-Ring Snap & Departure P3", () => {
  it("rejects out-of-reach and through-hood tricycle drags without moving the tricycle", () => {
    const initial = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);

    // 1. From driver seat (distance > 150 cm AND occluded by hood)
    const seated = step(initial, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt(DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos, {
        x: 15,
        y: 25,
        z: 55
      })
    });
    const dragFromSeat = step(seated, { type: "DragTricycle", targetXZ: { x: 150, z: 70 } });
    expect(dragFromSeat.tricyclePos).toEqual(DEFAULT_VEHICLE_GEOMETRY_SPEC.tricycle.initialPos);
    expect(dragFromSeat.isTricycleCleared).toBe(false);
    expect(dragFromSeat.lastRejectReason).toBe("OUT_OF_REACH");

    // 2. Within 150 cm XZ of tricycle (+15, 55), behind bumper/hood at (+15, 90, -50): distXZ = 105 <= 150, ray hits bumper
    const occludedClose = step(initial, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 15, y: 90, z: -50 }, { x: 15, y: 25, z: 55 })
    });
    const dragThroughHood = step(occludedClose, {
      type: "DragTricycle",
      targetXZ: { x: 150, z: 70 }
    });
    expect(dragThroughHood.tricyclePos).toEqual(DEFAULT_VEHICLE_GEOMETRY_SPEC.tricycle.initialPos);
    expect(dragThroughHood.isTricycleCleared).toBe(false);
    expect(dragThroughHood.lastRejectReason).toBe("OCCLUDED_BY_VEHICLE");
  });

  it("snaps valid releases past x > +85 or within 65 cm of (+150, +70) to Safe Parking Ring and clamps keepout box", () => {
    const initial = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);
    const nearTrike = step(initial, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 20, y: 140, z: 120 }, { x: 15, y: 25, z: 55 })
    });

    // Release inside cab/bumper keepout box is clamped outside keepout
    const clamped = step(nearTrike, { type: "DragTricycle", targetXZ: { x: 0, z: -50 } });
    expect(clamped.lastRejectReason).toBeNull();
    expect(clamped.tricyclePos.y).toBe(0);
    expect(clamped.tricyclePos.z).toBeGreaterThan(5);
    expect(clamped.isTricycleCleared).toBe(false);

    // Snap by x > +85
    const snappedByX = step(clamped, { type: "DragTricycle", targetXZ: { x: 90, z: 180 } });
    expect(snappedByX.tricyclePos).toEqual({ x: 150, y: 0, z: 70 });
    expect(snappedByX.isTricycleCleared).toBe(true);
    expect(snappedByX.lastRejectReason).toBeNull();

    // Drag back inside danger lane, then snap by distance <= 65 from (+150, +70)
    const moveNearRing = step(snappedByX, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 120, y: 140, z: 120 }, { x: 150, y: 25, z: 70 })
    });
    const movedBack = step(moveNearRing, { type: "DragTricycle", targetXZ: { x: 40, z: 80 } });
    expect(movedBack.isTricycleCleared).toBe(false);

    const snappedByDist = step(movedBack, { type: "DragTricycle", targetXZ: { x: 85, z: 70 } });
    expect(snappedByDist.tricyclePos).toEqual({ x: 150, y: 0, z: 70 });
    expect(snappedByDist.isTricycleCleared).toBe(true);
  });

  it("enforces full blocked -> walkaround -> clear -> depart -> auto-revert lifecycle and debug snapshot", () => {
    const seatPose = createCameraPoseLookAt(DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos, {
      x: -45,
      y: 152,
      z: 100
    });
    let state = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC, seatPose);

    // 1. Blocked departure in driver seat
    state = step(state, { type: "PressReadyToDepart" });
    expect(state.departureStatus).toBe("BLOCKED");
    expect(state.canDepart).toBe(false);
    expect(state.walkaroundBeaconsActive).toBe(true);

    // 2. Walk around and verify all 3 zones
    state = sweepZoneFromOutside(state, "FrontLeftAPillar");
    state = sweepZoneFromOutside(state, "FrontCenterHood");
    state = sweepZoneFromOutside(state, "FrontRightAPillar");
    expect(state.allZonesVerified).toBe(true);

    // 3. Move near tricycle and drag into Safe Parking Ring
    state = step(state, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 25, y: 140, z: 110 }, { x: 15, y: 25, z: 55 })
    });
    state = step(state, { type: "DragTricycle", targetXZ: { x: 150, z: 70 } });
    expect(state.isTricycleCleared).toBe(true);

    // 4. PressReadyToDepart while STILL outside driver seat must NOT clear
    const pressedOutside = step(state, { type: "PressReadyToDepart" });
    expect(pressedOutside.departureStatus).not.toBe("CLEARED");
    expect(pressedOutside.lastRejectReason).toBe("NOT_IN_DRIVER_SEAT");

    // 5. Return to driver seat and press Ready to Depart -> CLEARED
    state = step(pressedOutside, { type: "MoveCamera", pose: seatPose });
    expect(state.inDriverSeat).toBe(true);
    expect(state.canDepart).toBe(true);
    state = step(state, { type: "PressReadyToDepart" });
    expect(state.departureStatus).toBe("CLEARED");

    // 6. Debug snapshot serializes cleanly for single-line JSON logging
    const snapshot = getDebugSnapshot(state);
    expect(snapshot.departureStatus).toBe("CLEARED");
    expect(snapshot.isTricycleCleared).toBe(true);
    expect(snapshot.allZonesVerified).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    // 7. Leaving driver seat immediately reverts CLEARED -> IDLE
    const exitedSeat = step(state, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: -130, y: 150, z: 60 }, { x: 0, y: 2, z: 60 })
    });
    expect(exitedSeat.inDriverSeat).toBe(false);
    expect(exitedSeat.departureStatus).toBe("IDLE");

    // 8. Reset immediately restores everything to initial unverified state
    const reset = step(state, { type: "Reset" });
    expect(reset.departureStatus).toBe("IDLE");
    expect(reset.allZonesVerified).toBe(false);
    expect(reset.isTricycleCleared).toBe(false);
    expect(reset.tricyclePos).toEqual(DEFAULT_VEHICLE_GEOMETRY_SPEC.tricycle.initialPos);
    expect(reset.lastRejectReason).toBeNull();
  });

  it("enforces exact driver-seat bounds and reverts CLEARED immediately on tricycle lane re-entry", () => {
    const initial = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC);

    // Exact driver seat bounds: horizontalDistXZ <= 45 and |y - 152| <= 35
    const onEdgeSeat = step(initial, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 0, y: 117, z: -195 }, { x: 0, y: 117, z: 0 })
    });
    expect(onEdgeSeat.inDriverSeat).toBe(true);

    const outsideHoriz = step(initial, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 0.1, y: 152, z: -195 }, { x: 0.1, y: 152, z: 0 })
    });
    expect(outsideHoriz.inDriverSeat).toBe(false);

    const outsideVert = step(initial, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: -45, y: 187.1, z: -195 }, { x: -45, y: 187.1, z: 0 })
    });
    expect(outsideVert.inDriverSeat).toBe(false);

    const seatPose = createCameraPoseLookAt(DEFAULT_VEHICLE_GEOMETRY_SPEC.driverEyeLocalPos, {
      x: 0,
      y: 152,
      z: 100
    });
    let state = createInitialState(DEFAULT_VEHICLE_GEOMETRY_SPEC, seatPose);
    state = sweepZoneFromOutside(state, "FrontLeftAPillar");
    state = sweepZoneFromOutside(state, "FrontCenterHood");
    state = sweepZoneFromOutside(state, "FrontRightAPillar");
    state = step(state, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 20, y: 140, z: 120 }, { x: 15, y: 25, z: 55 })
    });
    state = step(state, { type: "DragTricycle", targetXZ: { x: 150, z: 70 } });
    state = step(state, { type: "MoveCamera", pose: seatPose });
    state = step(state, { type: "PressReadyToDepart" });
    expect(state.departureStatus).toBe("CLEARED");

    // Walk to Safe Parking Ring, drag tricycle back inside forward danger lane [-115, +115] x [0, +300]
    state = step(state, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 140, y: 140, z: 120 }, { x: 150, y: 25, z: 70 })
    });
    expect(state.departureStatus).toBe("IDLE");
    state = step(state, { type: "DragTricycle", targetXZ: { x: 0, z: 80 } });
    expect(state.isTricycleCleared).toBe(false);

    // Returning to seat with tricycle back in lane must block departure even though all 3 zones remain verified
    state = step(state, { type: "MoveCamera", pose: seatPose });
    expect(state.allZonesVerified).toBe(true);
    expect(state.isTricycleCleared).toBe(false);
    expect(state.canDepart).toBe(false);
    state = step(state, { type: "PressReadyToDepart" });
    expect(state.departureStatus).toBe("BLOCKED");

    // Direct in-seat tricycle re-entry revert with extended reach spec (keeping real occluders
    // so blind zones exist, placing tricycle at (-175, 0, 260) outside danger lane with clear view over hood).
    const extendedReachSpec = {
      ...DEFAULT_VEHICLE_GEOMETRY_SPEC,
      tricycle: {
        ...DEFAULT_VEHICLE_GEOMETRY_SPEC.tricycle,
        maxReachDistanceCm: 500
      }
    };
    const highSeatPose = createCameraPoseLookAt(
      { x: -45, y: 185, z: -155 },
      { x: -175, y: 25, z: 260 }
    );
    expect(
      isLineOfSightClear(extendedReachSpec, highSeatPose.position, { x: -175, y: 25, z: 260 })
    ).toBe(true);
    let directState = createInitialState(extendedReachSpec, highSeatPose);
    directState = sweepZoneFromOutside(directState, "FrontLeftAPillar");
    directState = sweepZoneFromOutside(directState, "FrontCenterHood");
    directState = sweepZoneFromOutside(directState, "FrontRightAPillar");
    directState = step(directState, {
      type: "MoveCamera",
      pose: createCameraPoseLookAt({ x: 20, y: 140, z: 120 }, { x: 15, y: 25, z: 55 })
    });
    directState = step(directState, { type: "DragTricycle", targetXZ: { x: -175, z: 260 } });
    expect(directState.isTricycleCleared).toBe(true);
    directState = step(directState, { type: "MoveCamera", pose: highSeatPose });
    directState = step(directState, { type: "PressReadyToDepart" });
    expect(directState.inDriverSeat).toBe(true);
    expect(directState.departureStatus).toBe("CLEARED");

    // Drag tricycle back into danger lane WITHOUT leaving driver seat -> immediate CLEARED -> IDLE revert
    const revertedInSeat = step(directState, {
      type: "DragTricycle",
      targetXZ: { x: 0, z: 80 }
    });
    expect(revertedInSeat.inDriverSeat).toBe(true);
    expect(revertedInSeat.isTricycleCleared).toBe(false);
    expect(revertedInSeat.canDepart).toBe(false);
    expect(revertedInSeat.departureStatus).toBe("IDLE");
  });
});

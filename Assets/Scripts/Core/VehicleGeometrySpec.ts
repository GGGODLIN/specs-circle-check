export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Vec2XZ {
  readonly x: number;
  readonly z: number;
}

export interface OccluderQuad {
  readonly vertices: readonly [Vec3, Vec3, Vec3, Vec3];
  readonly normal: Vec3;
}

export interface OccluderPrimitive {
  readonly id: string;
  readonly quads: readonly OccluderQuad[];
}

export type BlindSpotZoneId = "FrontLeftAPillar" | "FrontCenterHood" | "FrontRightAPillar";

export type CellClassification = "VehicleBody" | "Clear" | "Blind";

export interface FootprintCell {
  readonly index: number;
  readonly row: number;
  readonly col: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly classification: CellClassification;
  readonly zone: BlindSpotZoneId | null;
}

export interface FootprintClassification {
  readonly cells: readonly FootprintCell[];
  readonly zoneCellIndices: Readonly<Record<BlindSpotZoneId, readonly number[]>>;
  readonly blindCellCount: number;
  readonly estimatedFloorMeshVertices: number;
}

export interface SightlineTraceResult {
  readonly clear: boolean;
  readonly hitPoint: Vec3 | null;
  readonly hitOccluderId: string | null;
}

export interface VehicleGeometrySpec {
  readonly vehicleWidthCm: number;
  readonly bumperHeightCm: number;
  readonly bumperZCm: number;
  readonly hoodRearHeightCm: number;
  readonly hoodRearZCm: number;
  readonly aPillarTopHeightCm: number;
  readonly aPillarRearZCm: number;
  readonly aPillarWidthCm: number;
  readonly driverEyeLocalPos: Vec3;
  readonly dashboardStripLocalPos: Vec3;
  readonly driverSeatHorizontalRadiusCm: number;
  readonly driverSeatVerticalToleranceCm: number;
  readonly walkaroundMinDriverDistCm: number;
  readonly toddlerHeightCm: number;
  readonly footprint: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
    readonly cellSizeCm: number;
    readonly cols: number;
    readonly rows: number;
    readonly vehicleBodyBox: {
      readonly minX: number;
      readonly maxX: number;
      readonly minZ: number;
      readonly maxZ: number;
    };
    readonly floorSampleYCm: number;
  };
  readonly frustum: {
    readonly horizontalFovDeg: number;
    readonly verticalFovDeg: number;
    readonly tanHalfHorizontalFov: number;
    readonly tanHalfVerticalFov: number;
    readonly maxInspectDistanceCm: number;
    readonly zoneVerifyThreshold: number;
  };
  readonly tricycle: {
    readonly initialPos: Vec3;
    readonly heightCm: number;
    readonly rayTargetYCm: number;
    readonly maxReachDistanceCm: number;
    readonly dangerLane: {
      readonly minX: number;
      readonly maxX: number;
      readonly minZ: number;
      readonly maxZ: number;
    };
    readonly safeParkingRing: {
      readonly center: Vec2XZ;
      readonly radiusCm: number;
      readonly snapDistanceCm: number;
      readonly snapMinXCm: number;
    };
    readonly dragBounds: {
      readonly minX: number;
      readonly maxX: number;
      readonly minZ: number;
      readonly maxZ: number;
    };
    readonly keepoutBox: {
      readonly minX: number;
      readonly maxX: number;
      readonly minZ: number;
      readonly maxZ: number;
    };
  };
  readonly checkpointBeacons: Readonly<Record<BlindSpotZoneId, Vec3>>;
  readonly occluders: readonly OccluderPrimitive[];
}

export const BLIND_SPOT_ZONE_IDS: readonly [
  BlindSpotZoneId,
  BlindSpotZoneId,
  BlindSpotZoneId
] = Object.freeze(["FrontLeftAPillar", "FrontCenterHood", "FrontRightAPillar"] as const);

const DEG_TO_RAD = Math.PI / 180;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function subVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
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
    return { x: 0, y: 0, z: 0 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function compareVec3(a: Vec3, b: Vec3): number {
  if (a.x !== b.x) {
    return a.x < b.x ? -1 : 1;
  }
  if (a.y !== b.y) {
    return a.y < b.y ? -1 : 1;
  }
  if (a.z !== b.z) {
    return a.z < b.z ? -1 : 1;
  }
  return 0;
}

function createQuad(v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3): OccluderQuad {
  const normal = normalizeVec3(crossVec3(subVec3(v1, v0), subVec3(v2, v0)));
  return {
    vertices: [v0, v1, v2, v3],
    normal
  };
}

function createOccluder(id: string, quads: readonly OccluderQuad[]): OccluderPrimitive {
  return { id, quads };
}

function createBoxQuads(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number
): readonly OccluderQuad[] {
  return [
    createQuad(
      { x: minX, y: minY, z: maxZ },
      { x: maxX, y: minY, z: maxZ },
      { x: maxX, y: maxY, z: maxZ },
      { x: minX, y: maxY, z: maxZ }
    ),
    createQuad(
      { x: maxX, y: minY, z: minZ },
      { x: minX, y: minY, z: minZ },
      { x: minX, y: maxY, z: minZ },
      { x: maxX, y: maxY, z: minZ }
    ),
    createQuad(
      { x: minX, y: minY, z: minZ },
      { x: minX, y: minY, z: maxZ },
      { x: minX, y: maxY, z: maxZ },
      { x: minX, y: maxY, z: minZ }
    ),
    createQuad(
      { x: maxX, y: minY, z: maxZ },
      { x: maxX, y: minY, z: minZ },
      { x: maxX, y: maxY, z: minZ },
      { x: maxX, y: maxY, z: maxZ }
    ),
    createQuad(
      { x: minX, y: maxY, z: maxZ },
      { x: maxX, y: maxY, z: maxZ },
      { x: maxX, y: maxY, z: minZ },
      { x: minX, y: maxY, z: minZ }
    ),
    createQuad(
      { x: minX, y: minY, z: minZ },
      { x: maxX, y: minY, z: minZ },
      { x: maxX, y: minY, z: maxZ },
      { x: minX, y: minY, z: maxZ }
    )
  ];
}

function buildDefaultVehicleGeometrySpec(): VehicleGeometrySpec {
  const halfWidth = 100;
  const bumperY = 112;
  const bumperZ = 0;
  const hoodRearY = 118;
  const hoodRearZ = -150;
  const aPillarTopY = 172;
  const aPillarRearZ = -185;
  const aPillarWidth = 18;

  const frontBumper = createOccluder("front-bumper", [
    createQuad(
      { x: -halfWidth, y: 0, z: bumperZ },
      { x: halfWidth, y: 0, z: bumperZ },
      { x: halfWidth, y: bumperY, z: bumperZ },
      { x: -halfWidth, y: bumperY, z: bumperZ }
    )
  ]);

  const slopedHood = createOccluder("sloped-hood", [
    createQuad(
      { x: -halfWidth, y: bumperY, z: bumperZ },
      { x: halfWidth, y: bumperY, z: bumperZ },
      { x: halfWidth, y: hoodRearY, z: hoodRearZ },
      { x: -halfWidth, y: hoodRearY, z: hoodRearZ }
    )
  ]);

  // Left/right fenders and cab firewall close the engine bay volume so lateral rays cannot pass under the hood.
  const leftFender = createOccluder("left-fender", [
    createQuad(
      { x: -halfWidth, y: 0, z: hoodRearZ },
      { x: -halfWidth, y: 0, z: bumperZ },
      { x: -halfWidth, y: bumperY, z: bumperZ },
      { x: -halfWidth, y: hoodRearY, z: hoodRearZ }
    )
  ]);

  const rightFender = createOccluder("right-fender", [
    createQuad(
      { x: halfWidth, y: 0, z: bumperZ },
      { x: halfWidth, y: 0, z: hoodRearZ },
      { x: halfWidth, y: hoodRearY, z: hoodRearZ },
      { x: halfWidth, y: bumperY, z: bumperZ }
    )
  ]);

  const cabFirewall = createOccluder("cab-firewall", [
    createQuad(
      { x: halfWidth, y: 0, z: hoodRearZ },
      { x: -halfWidth, y: 0, z: hoodRearZ },
      { x: -halfWidth, y: hoodRearY, z: hoodRearZ },
      { x: halfWidth, y: hoodRearY, z: hoodRearZ }
    )
  ]);

  const leftAPillar = createOccluder(
    "left-a-pillar",
    createBoxQuads(
      -halfWidth,
      -halfWidth + aPillarWidth,
      hoodRearY,
      aPillarTopY,
      aPillarRearZ,
      hoodRearZ
    )
  );

  const rightAPillar = createOccluder(
    "right-a-pillar",
    createBoxQuads(
      halfWidth - aPillarWidth,
      halfWidth,
      hoodRearY,
      aPillarTopY,
      aPillarRearZ,
      hoodRearZ
    )
  );

  const horizontalFovDeg = 32;
  const verticalFovDeg = 37;

  return deepFreeze({
    vehicleWidthCm: halfWidth * 2,
    bumperHeightCm: bumperY,
    bumperZCm: bumperZ,
    hoodRearHeightCm: hoodRearY,
    hoodRearZCm: hoodRearZ,
    aPillarTopHeightCm: aPillarTopY,
    aPillarRearZCm: aPillarRearZ,
    aPillarWidthCm: aPillarWidth,
    driverEyeLocalPos: { x: -45, y: 152, z: -195 },
    dashboardStripLocalPos: { x: -45, y: 136, z: -152 },
    driverSeatHorizontalRadiusCm: 45,
    driverSeatVerticalToleranceCm: 35,
    walkaroundMinDriverDistCm: 50,
    toddlerHeightCm: 70,
    footprint: {
      minX: -180,
      maxX: 180,
      minZ: -40,
      maxZ: 320,
      cellSizeCm: 20,
      cols: 18,
      rows: 18,
      vehicleBodyBox: {
        minX: -100,
        maxX: 100,
        minZ: -220,
        maxZ: 0
      },
      floorSampleYCm: 2
    },
    frustum: {
      horizontalFovDeg,
      verticalFovDeg,
      tanHalfHorizontalFov: Math.tan((horizontalFovDeg / 2) * DEG_TO_RAD),
      tanHalfVerticalFov: Math.tan((verticalFovDeg / 2) * DEG_TO_RAD),
      maxInspectDistanceCm: 300,
      zoneVerifyThreshold: 0.6
    },
    tricycle: {
      initialPos: { x: 15, y: 0, z: 55 },
      heightCm: 50,
      rayTargetYCm: 25,
      maxReachDistanceCm: 150,
      dangerLane: {
        minX: -115,
        maxX: 115,
        minZ: 0,
        maxZ: 300
      },
      safeParkingRing: {
        center: { x: 150, z: 70 },
        radiusCm: 25,
        snapDistanceCm: 65,
        snapMinXCm: 85
      },
      dragBounds: {
        minX: -180,
        maxX: 180,
        minZ: 5,
        maxZ: 300
      },
      keepoutBox: {
        minX: -105,
        maxX: 105,
        minZ: -220,
        maxZ: 5
      }
    },
    checkpointBeacons: {
      FrontLeftAPillar: { x: -135, y: 110, z: 90 },
      FrontCenterHood: { x: 0, y: 110, z: 160 },
      FrontRightAPillar: { x: 135, y: 110, z: 90 }
    },
    occluders: [
      frontBumper,
      slopedHood,
      leftFender,
      rightFender,
      cabFirewall,
      leftAPillar,
      rightAPillar
    ]
  });
}

export const DEFAULT_VEHICLE_GEOMETRY_SPEC: VehicleGeometrySpec =
  buildDefaultVehicleGeometrySpec();

export function horizontalDistXZ(a: Vec2XZ, b: Vec2XZ): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

interface TriangleHit {
  readonly tDirected: number;
  readonly hitPoint: Vec3;
}

// Canonicalize endpoint order before intersection so isLineOfSightClear(A, B) === isLineOfSightClear(B, A)
// holds bit-for-bit even on grazing edges and quad diagonals.
function intersectSegmentTriangleCanonical(
  from: Vec3,
  to: Vec3,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3
): TriangleHit | null {
  const rayEps = 1e-9;
  const baryEps = 1e-9;

  const swapped = compareVec3(from, to) > 0;
  const p0 = swapped ? to : from;
  const p1 = swapped ? from : to;
  const dir = subVec3(p1, p0);

  if (dotVec3(dir, dir) <= rayEps * rayEps) {
    return null;
  }

  const e1 = subVec3(v1, v0);
  const e2 = subVec3(v2, v0);
  const pvec = crossVec3(dir, e2);
  const det = dotVec3(e1, pvec);

  if (Math.abs(det) < rayEps) {
    return null;
  }

  const invDet = 1 / det;
  const tvec = subVec3(p0, v0);
  const u = dotVec3(tvec, pvec) * invDet;

  if (u < -baryEps || u > 1 + baryEps) {
    return null;
  }

  const qvec = crossVec3(tvec, e1);
  const v = dotVec3(dir, qvec) * invDet;

  if (v < -baryEps || u + v > 1 + baryEps) {
    return null;
  }

  const tCanonical = dotVec3(e2, qvec) * invDet;
  if (tCanonical < -rayEps || tCanonical > 1 + rayEps) {
    return null;
  }

  const tClamped = Math.min(1, Math.max(0, tCanonical));
  const tDirected = swapped ? 1 - tClamped : tClamped;

  return {
    tDirected,
    hitPoint: {
      x: p0.x + tClamped * dir.x,
      y: p0.y + tClamped * dir.y,
      z: p0.z + tClamped * dir.z
    }
  };
}

export function traceSightline(
  spec: VehicleGeometrySpec,
  from: Vec3,
  to: Vec3
): SightlineTraceResult {
  let closestT = Infinity;
  let closestHitPoint: Vec3 | null = null;
  let closestOccluderId: string | null = null;

  for (const occluder of spec.occluders) {
    for (const quad of occluder.quads) {
      const [v0, v1, v2, v3] = quad.vertices;
      const triHits: readonly (TriangleHit | null)[] = [
        intersectSegmentTriangleCanonical(from, to, v0, v1, v2),
        intersectSegmentTriangleCanonical(from, to, v0, v2, v3)
      ];

      for (const hit of triHits) {
        if (hit !== null && hit.tDirected < closestT) {
          closestT = hit.tDirected;
          closestHitPoint = hit.hitPoint;
          closestOccluderId = occluder.id;
        }
      }
    }
  }

  if (closestHitPoint === null) {
    return { clear: true, hitPoint: null, hitOccluderId: null };
  }

  return {
    clear: false,
    hitPoint: closestHitPoint,
    hitOccluderId: closestOccluderId
  };
}

export function isLineOfSightClear(
  spec: VehicleGeometrySpec,
  a: Vec3,
  b: Vec3
): boolean {
  return traceSightline(spec, a, b).clear;
}

function assignBlindSpotZone(centerX: number, hitOccluderId: string | null): BlindSpotZoneId {
  if (hitOccluderId === "left-a-pillar") {
    return "FrontLeftAPillar";
  }
  if (hitOccluderId === "right-a-pillar") {
    return "FrontRightAPillar";
  }
  if (centerX < -60) {
    return "FrontLeftAPillar";
  }
  if (centerX > 60) {
    return "FrontRightAPillar";
  }
  return "FrontCenterHood";
}

export function classifyFootprintCells(spec: VehicleGeometrySpec): FootprintClassification {
  const { minX, minZ, cellSizeCm, cols, rows, vehicleBodyBox } = spec.footprint;
  const cells: FootprintCell[] = [];
  const zoneBuckets: Record<BlindSpotZoneId, number[]> = {
    FrontLeftAPillar: [],
    FrontCenterHood: [],
    FrontRightAPillar: []
  };

  for (let row = 0; row < rows; row += 1) {
    const centerZ = minZ + (row + 0.5) * cellSizeCm;
    for (let col = 0; col < cols; col += 1) {
      const centerX = minX + (col + 0.5) * cellSizeCm;
      const index = row * cols + col;

      const insideBody =
        centerX >= vehicleBodyBox.minX &&
        centerX <= vehicleBodyBox.maxX &&
        centerZ >= vehicleBodyBox.minZ &&
        centerZ <= vehicleBodyBox.maxZ;

      if (insideBody) {
        cells.push({
          index,
          row,
          col,
          centerX,
          centerZ,
          classification: "VehicleBody",
          zone: null
        });
        continue;
      }

      const trace = traceSightline(spec, spec.driverEyeLocalPos, {
        x: centerX,
        y: spec.toddlerHeightCm,
        z: centerZ
      });

      if (trace.clear) {
        cells.push({
          index,
          row,
          col,
          centerX,
          centerZ,
          classification: "Clear",
          zone: null
        });
      } else {
        const zone = assignBlindSpotZone(centerX, trace.hitOccluderId);
        zoneBuckets[zone].push(index);
        cells.push({
          index,
          row,
          col,
          centerX,
          centerZ,
          classification: "Blind",
          zone
        });
      }
    }
  }

  const blindCellCount =
    zoneBuckets.FrontLeftAPillar.length +
    zoneBuckets.FrontCenterHood.length +
    zoneBuckets.FrontRightAPillar.length;

  return {
    cells,
    zoneCellIndices: {
      FrontLeftAPillar: zoneBuckets.FrontLeftAPillar,
      FrontCenterHood: zoneBuckets.FrontCenterHood,
      FrontRightAPillar: zoneBuckets.FrontRightAPillar
    },
    blindCellCount,
    estimatedFloorMeshVertices: blindCellCount * 4
  };
}

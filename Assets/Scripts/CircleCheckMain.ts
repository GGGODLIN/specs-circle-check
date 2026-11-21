import {
  BLIND_SPOT_ZONE_IDS,
  DEFAULT_VEHICLE_GEOMETRY_SPEC,
  createInitialState,
  getDebugSnapshot as coreSnapshot,
  step,
  type BlindSpotZoneId,
  type CameraPose,
  type CircleCheckState,
  type DebugSnapshot,
  type Vec3,
} from "./Core/CircleCheckCore"
import {MeshAccumulator} from "./Scene/MeshAccumulator"

const SPEC = DEFAULT_VEHICLE_GEOMETRY_SPEC

const COLOR = {
  occluderFill: new vec4(0.04, 0.16, 0.32, 1),
  wireframe: new vec4(0.65, 0.95, 1, 1),
  beamClear: new vec4(0.2, 1, 0.35, 1),
  beamBlocked: new vec4(1, 0.15, 0.1, 1),
  hitMarker: new vec4(1, 0.1, 0.1, 1),
  zoneUnchecked: new vec4(1, 0.35, 0.05, 1),
  zoneVerified: new vec4(0.1, 1, 0.75, 1),
}

function toVec3(p: Vec3): vec3 {
  return new vec3(p.x, p.y, p.z)
}

function toPlain(v: vec3): Vec3 {
  return {x: v.x, y: v.y, z: v.z}
}

// Camera looks down its local -Z, so its rotation maps +Z onto the reversed view direction.
function cameraRotationFor(viewDir: vec3): quat {
  return quat.lookAt(viewDir.uniformScale(-1), vec3.up())
}

function flatten(dir: vec3): vec3 {
  const flat = new vec3(dir.x, 0, dir.z)
  return flat.length < 1e-4 ? new vec3(0, 0, -1) : flat.normalize()
}

@component
export class CircleCheckMain extends BaseScriptComponent {
  @input cameraObject: SceneObject
  @input baseMaterial: Material

  private state: CircleCheckState = createInitialState(SPEC)
  private lastLoggedKey = ""

  private beam: SceneObject
  private beamVisual: RenderMeshVisual
  private hitMarker: SceneObject
  private zoneVisuals: Record<BlindSpotZoneId, RenderMeshVisual>

  onAwake(): void {
    this.buildVehicle()
    this.buildSightline()
    this.buildZones()
    this.createEvent("OnStartEvent").bind(() => {
      this.placeViewpoint(new vec3(-45, 160, 100), toVec3(SPEC.driverEyeLocalPos), true)
    })
    // LateUpdate so DeviceTracking has already written this frame's camera pose.
    this.createEvent("LateUpdateEvent").bind(() => this.tick())
  }

  /**
   * Anchors VehicleRoot so the live camera sits at `localEye` looking at `localLookAt` in vehicle space.
   * Boot uses it upright; LEAF uses the full pose because DeviceTracking owns the camera transform.
   */
  placeViewpoint(localEye: vec3, localLookAt: vec3, keepUpright: boolean = false): void {
    const camT = this.cameraObject.getTransform()
    const camPos = camT.getWorldPosition()
    const camRot = camT.getWorldRotation()
    const localDir = localLookAt.sub(localEye).normalize()

    let rootRot: quat
    if (keepUpright) {
      const camYaw = cameraRotationFor(flatten(camRot.multiplyVec3(new vec3(0, 0, -1))))
      rootRot = camYaw.multiply(cameraRotationFor(flatten(localDir)).invert())
    } else {
      rootRot = camRot.multiply(cameraRotationFor(localDir).invert())
    }
    const rootT = this.getTransform()
    rootT.setWorldRotation(rootRot)
    rootT.setWorldPosition(camPos.sub(rootRot.multiplyVec3(localEye)))
    this.tick()
  }

  getDebugSnapshot(): DebugSnapshot {
    return coreSnapshot(this.state)
  }

  private currentCameraPose(): CameraPose {
    const inv = this.getTransform().getInvertedWorldTransform()
    const camT = this.cameraObject.getTransform()
    const camRot = camT.getWorldRotation()
    const pos = inv.multiplyPoint(camT.getWorldPosition())
    const forward = inv.multiplyDirection(camRot.multiplyVec3(new vec3(0, 0, -1))).normalize()
    const right = inv.multiplyDirection(camRot.multiplyVec3(new vec3(1, 0, 0))).normalize()
    const up = inv.multiplyDirection(camRot.multiplyVec3(new vec3(0, 1, 0))).normalize()
    return {position: toPlain(pos), forward: toPlain(forward), right: toPlain(right), up: toPlain(up)}
  }

  private tick(): void {
    this.state = step(this.state, {type: "MoveCamera", pose: this.currentCameraPose()})
    this.render()
    this.logTransition()
  }

  private logTransition(): void {
    const s = this.getDebugSnapshot()
    const key = JSON.stringify([
      s.inDriverSeat,
      s.sightlineBlocked,
      s.zoneVerified,
      s.departureStatus,
      s.isTricycleCleared,
      s.lastRejectReason,
      s.walkaroundBeaconsActive,
    ])
    if (key !== this.lastLoggedKey) {
      this.lastLoggedKey = key
      print(`[CircleCheckMain] ${JSON.stringify(s)}`)
    }
  }

  private render(): void {
    const s = this.state
    const showBeam = !s.inDriverSeat
    this.beam.enabled = showBeam
    this.hitMarker.enabled = showBeam && !s.sightline.clear
    if (showBeam) {
      const from = toVec3(SPEC.driverEyeLocalPos)
      const eye = toVec3(s.cameraPose.position)
      // Stop short of the viewer's eye so the near plane never clips the clear beam.
      const to = s.sightline.hitPoint !== null ? toVec3(s.sightline.hitPoint) : eye.sub(eye.sub(from).normalize().uniformScale(30))
      this.placeBeam(from, to)
      this.beamVisual.mainMaterial.mainPass.baseColor = s.sightline.clear ? COLOR.beamClear : COLOR.beamBlocked
      if (s.sightline.hitPoint !== null) {
        this.hitMarker.getTransform().setLocalPosition(toVec3(s.sightline.hitPoint))
      }
    }
    for (const zone of BLIND_SPOT_ZONE_IDS) {
      this.zoneVisuals[zone].mainMaterial.mainPass.baseColor = s.zoneVerified[zone] ? COLOR.zoneVerified : COLOR.zoneUnchecked
    }
  }

  private placeBeam(from: vec3, to: vec3): void {
    const delta = to.sub(from)
    const length = Math.max(delta.length, 0.01)
    const t = this.beam.getTransform()
    t.setLocalPosition(from)
    t.setLocalRotation(quat.lookAt(delta.normalize(), Math.abs(delta.normalize().y) > 0.99 ? vec3.right() : vec3.up()))
    t.setLocalScale(new vec3(1, 1, length))
  }

  // Overlays skip the depth test: the hood hit point sits on the hood top, which the bumper hides from a crouched viewer.
  private material(color: vec4, depthWrite: boolean = true, overlay: boolean = false): Material {
    const m = this.baseMaterial.clone()
    m.mainPass.baseColor = color
    m.mainPass.depthWrite = depthWrite && !overlay
    m.mainPass.depthTest = !overlay
    m.mainPass.twoSided = true
    return m
  }

  private child(name: string, mesh: RenderMesh, material: Material): SceneObject {
    const obj = global.scene.createSceneObject(name)
    obj.setParent(this.getSceneObject())
    const visual = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    visual.mesh = mesh
    visual.mainMaterial = material
    return obj
  }

  private buildVehicle(): void {
    const fill = new MeshAccumulator()
    const edges = new MeshAccumulator()
    for (const occluder of SPEC.occluders) {
      for (const q of occluder.quads) {
        const [a, b, c, d] = q.vertices
        fill.quad(a, b, c, d)
        edges.segment(a, b, 1.6)
        edges.segment(b, c, 1.6)
        edges.segment(c, d, 1.6)
        edges.segment(d, a, 1.6)
      }
    }
    this.child("VehicleOccluders", fill.build(), this.material(COLOR.occluderFill, true))
    this.child("VehicleWireframe", edges.build(), this.material(COLOR.wireframe, true))
  }

  private buildSightline(): void {
    const beam = new MeshAccumulator()
    beam.segment(new vec3(0, 0, 0), new vec3(0, 0, 1), 1.4)
    this.beam = this.child("SightlineBeam", beam.build(), this.material(COLOR.beamClear, false, true))
    this.beamVisual = this.beam.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    const marker = new MeshAccumulator()
    marker.box(new vec3(-7, -7, -7), new vec3(7, 7, 7))
    this.hitMarker = this.child("SightlineHitMarker", marker.build(), this.material(COLOR.hitMarker, false, true))
  }

  private buildZones(): void {
    const {cells, zoneCellIndices} = this.state.footprint
    const half = SPEC.footprint.cellSizeCm / 2 - 1.5
    const y = 0.6
    const visuals: Partial<Record<BlindSpotZoneId, RenderMeshVisual>> = {}
    let totalVertices = 0
    for (const zone of BLIND_SPOT_ZONE_IDS) {
      const acc = new MeshAccumulator()
      for (const index of zoneCellIndices[zone]) {
        const c = cells[index]
        acc.quad(
          new vec3(c.centerX - half, y, c.centerZ + half),
          new vec3(c.centerX + half, y, c.centerZ + half),
          new vec3(c.centerX + half, y, c.centerZ - half),
          new vec3(c.centerX - half, y, c.centerZ - half),
        )
      }
      totalVertices += acc.vertexCount
      const obj = this.child(`Zone_${zone}`, acc.build(), this.material(COLOR.zoneUnchecked, true))
      visuals[zone] = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    }
    this.zoneVisuals = visuals as Record<BlindSpotZoneId, RenderMeshVisual>
    print(`[CircleCheckMain] floorZoneVertices=${totalVertices}`)
  }
}

import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractableManipulation} from "InteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import {Button} from "UIKit.lspkg/Scripts/Components/Button/Button"
import {ElementContent} from "UIKit.lspkg/Scripts/Components/Content/ElementContent"
import {addContentToElement} from "UIKit.lspkg/Scripts/Components/Content/ElementContentFactory"
import {createChildSceneObjectWithParentLayer} from "UIKit.lspkg/Scripts/Utility/SceneUtilities"
import {
  BLIND_SPOT_ZONE_IDS,
  DEFAULT_VEHICLE_GEOMETRY_SPEC,
  clampTricycleDragTarget,
  createInitialState,
  getDebugSnapshot as coreSnapshot,
  step,
  type BlindSpotZoneId,
  type CameraPose,
  type CircleCheckAction,
  type CircleCheckState,
  type DebugSnapshot,
  type FootprintClassification,
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
  beacon: new vec4(1, 0.78, 0.1, 1),
  tricycle: new vec4(1, 0.3, 0.85, 1),
  safeRing: new vec4(0.1, 0.9, 1, 1),
  label: new vec4(1, 1, 1, 1),
  barIdle: new vec4(0.75, 0.48, 0.02, 1),
  barBlocked: new vec4(0.85, 0.06, 0.06, 1),
  barCleared: new vec4(0.05, 0.7, 0.25, 1),
}

const ZONE_LABEL: Record<BlindSpotZoneId, string> = {
  FrontLeftAPillar: "Left",
  FrontCenterHood: "Hood",
  FrontRightAPillar: "Right",
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
  @input sfxIntercept: AudioTrackAsset
  @input sfxZoneVerified: AudioTrackAsset
  @input sfxTrikeSnap: AudioTrackAsset
  @input sfxDepartCleared: AudioTrackAsset

  private state: CircleCheckState = createInitialState(SPEC)
  private lastLoggedKey = ""
  private lastLabelKey = ""

  private beam: SceneObject
  private beamVisual: RenderMeshVisual
  private hitMarker: SceneObject
  private zoneVisuals: Record<BlindSpotZoneId, RenderMeshVisual>
  private beacons: Record<BlindSpotZoneId, SceneObject>
  private cockpitStrip: SceneObject
  private statusLabel: ElementContent
  private statusBar: RenderMeshVisual
  private progressLabel: ElementContent
  private sightlineLabel: ElementContent
  private sightlineLabelObj: SceneObject
  private lastSightlineText = ""
  private tricycle: SceneObject
  private manipulation: InteractableManipulation
  // True only between an accepted drag start and its release; a rejected grab never moves the tricycle.
  private dragAccepted = false
  private audio: Record<"intercept" | "zone" | "snap" | "depart", AudioComponent>

  onAwake(): void {
    this.buildVehicle()
    this.buildSightline()
    this.buildSightlineLabel()
    this.buildZones()
    this.buildBeacons()
    this.buildSafeRing()
    this.buildTricycle()
    this.buildCockpit()
    this.buildAudio()
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

  getFootprint(): FootprintClassification {
    return this.state.footprint
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
    this.apply({type: "MoveCamera", pose: this.currentCameraPose()})
  }

  private apply(action: CircleCheckAction): void {
    const prev = this.state
    this.state = step(prev, action)
    this.playCues(prev, this.state, action)
    this.render()
    this.logTransition()
  }

  private playCues(prev: CircleCheckState, next: CircleCheckState, action: CircleCheckAction): void {
    if (action.type === "PressReadyToDepart" && next.departureStatus === "BLOCKED") {
      this.audio.intercept.play(1)
    }
    if (action.type === "DragTricycle" && next.lastRejectReason !== null) {
      this.audio.intercept.play(1)
    }
    if (prev.departureStatus !== "CLEARED" && next.departureStatus === "CLEARED") {
      this.audio.depart.play(1)
    }
    if (!prev.isTricycleCleared && next.isTricycleCleared) {
      this.audio.snap.play(1)
    }
    if (BLIND_SPOT_ZONE_IDS.some((z) => !prev.zoneVerified[z] && next.zoneVerified[z])) {
      this.audio.zone.play(1)
    }
  }

  private onReadyPressed(): void {
    if (this.dragAccepted) {
      this.onTricycleRelease()
    }
    this.apply({type: "PressReadyToDepart"})
  }

  private onResetPressed(): void {
    this.dragAccepted = false
    this.apply({type: "Reset"})
  }

  private onTricycleGrab(): void {
    const p = this.state.tricyclePos
    // Gate on the product rule (reach + occlusion from the live viewpoint), not on whether the
    // interactor ray happened to hit the collider: LEAF and far-field rays pass straight through the hood.
    this.apply({type: "DragTricycle", targetXZ: {x: p.x, z: p.z}})
    this.dragAccepted = this.state.lastRejectReason === null
    this.manipulation.setCanTranslate(this.dragAccepted)
  }

  private onTricycleRelease(): void {
    if (this.dragAccepted) {
      const local = this.tricycleLocal()
      this.apply({type: "DragTricycle", targetXZ: {x: local.x, z: local.z}})
    }
    this.dragAccepted = false
    this.manipulation.setCanTranslate(true)
    this.syncTricycleVisual()
  }

  private tricycleLocal(): vec3 {
    return this.getTransform().getInvertedWorldTransform().multiplyPoint(this.tricycle.getTransform().getWorldPosition())
  }

  private syncTricycleVisual(): void {
    const t = this.tricycle.getTransform()
    if (this.dragAccepted) {
      const local = this.tricycleLocal()
      const clamped = clampTricycleDragTarget(SPEC, {x: local.x, z: local.z})
      t.setLocalPosition(new vec3(clamped.x, 0, clamped.z))
      // Advance core position in-flight (pre-snap) so walking alongside the tricycle keeps reach valid
      // and dragging back into the lane revokes departure clearance immediately.
      const ring = SPEC.tricycle.safeParkingRing
      const wouldSnap =
        clamped.x > ring.snapMinXCm ||
        Math.hypot(clamped.x - ring.center.x, clamped.z - ring.center.z) <= ring.snapDistanceCm
      const moved = Math.hypot(clamped.x - this.state.tricyclePos.x, clamped.z - this.state.tricyclePos.z)
      if (!wouldSnap && moved >= 20) {
        this.state = step(this.state, {type: "DragTricycle", targetXZ: clamped})
        this.logTransition()
      }
    } else {
      t.setLocalPosition(toVec3(this.state.tricyclePos))
    }
    t.setLocalRotation(quat.quatIdentity())
    t.setLocalScale(vec3.one())
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
    this.sightlineLabelObj.enabled = showBeam
    if (showBeam) {
      this.renderSightlineLabel(toVec3(s.cameraPose.position))
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
      this.beacons[zone].enabled = s.walkaroundBeaconsActive && !s.zoneVerified[zone]
    }
    this.cockpitStrip.enabled = s.inDriverSeat
    this.syncTricycleVisual()
    this.renderLabels()
  }

  private renderLabels(): void {
    const s = this.state
    const verifiedCount = BLIND_SPOT_ZONE_IDS.filter((z) => s.zoneVerified[z]).length
    const zones = BLIND_SPOT_ZONE_IDS.map((z) => `${ZONE_LABEL[z]} ${s.zoneVerified[z] ? "OK" : "--"}`).join("  ")
    const trike = s.isTricycleCleared ? "clear" : "IN LANE"
    const refused = s.lastRejectReason !== null ? `  |  Grab refused: ${s.lastRejectReason.replace(/_/g, " ")}` : ""
    const progress = `Zones ${verifiedCount}/3  ${zones}  |  Trike ${trike}${refused}`
    const key = `${progress}|${s.departureStatus}`
    // Labels re-layout on every write, so skip the per-frame no-op updates.
    if (key === this.lastLabelKey) {
      return
    }
    this.lastLabelKey = key
    this.progressLabel.text = progress
    if (s.departureStatus === "CLEARED") {
      this.statusLabel.text = "CLEARED - safe to depart"
      this.statusBar.mainMaterial.mainPass.baseColor = COLOR.barCleared
    } else if (s.departureStatus === "BLOCKED") {
      this.statusLabel.text = s.allZonesVerified ? "BLOCKED - clear the tricycle" : "BLOCKED - walk the 3 beacons"
      this.statusBar.mainMaterial.mainPass.baseColor = COLOR.barBlocked
    } else {
      this.statusLabel.text = "Circle Check before you depart"
      this.statusBar.mainMaterial.mainPass.baseColor = COLOR.barIdle
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

  private buildBeacons(): void {
    const beacons: Partial<Record<BlindSpotZoneId, SceneObject>> = {}
    for (const zone of BLIND_SPOT_ZONE_IDS) {
      const top = SPEC.checkpointBeacons[zone]
      const acc = new MeshAccumulator()
      acc.segment(new vec3(top.x, 0, top.z), new vec3(top.x, top.y, top.z), 4)
      acc.box(new vec3(top.x - 7, top.y, top.z - 7), new vec3(top.x + 7, top.y + 14, top.z + 7))
      acc.ringXZ(new vec3(top.x, 0, top.z), 22, 1, 24, 2.5)
      beacons[zone] = this.child(`Beacon_${zone}`, acc.build(), this.material(COLOR.beacon))
    }
    this.beacons = beacons as Record<BlindSpotZoneId, SceneObject>
  }

  private buildSafeRing(): void {
    const ring = SPEC.tricycle.safeParkingRing
    const acc = new MeshAccumulator()
    acc.ringXZ(new vec3(ring.center.x, 0, ring.center.z), ring.radiusCm, 1, 40, 3)
    acc.ringXZ(new vec3(ring.center.x, 0, ring.center.z), ring.radiusCm - 6, 1, 40, 1.5)
    this.child("SafeParkingRing", acc.build(), this.material(COLOR.safeRing))
  }

  private buildTricycle(): void {
    const t = 2.5
    const acc = new MeshAccumulator()
    acc.ringYZ(new vec3(-20, 10, -15), 10, 16, t)
    acc.ringYZ(new vec3(20, 10, -15), 10, 16, t)
    acc.ringYZ(new vec3(0, 13, 18), 13, 16, t)
    acc.segment(new vec3(-20, 10, -15), new vec3(20, 10, -15), t)
    acc.segment(new vec3(0, 10, -15), new vec3(0, 28, -5), t)
    acc.segment(new vec3(0, 28, -5), new vec3(0, 34, 14), t)
    acc.segment(new vec3(0, 13, 18), new vec3(0, 50, 14), t)
    acc.segment(new vec3(-14, 50, 13), new vec3(14, 50, 13), t)
    acc.box(new vec3(-9, 28, -14), new vec3(9, 32, 0))
    this.tricycle = this.child("Tricycle", acc.build(), this.material(COLOR.tricycle))

    const collider = this.tricycle.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createBoxShape()
    shape.size = new vec3(56, 2 * SPEC.tricycle.heightCm, 60)
    collider.shape = shape
    collider.fitVisual = false

    const interactable = this.tricycle.createComponent(Interactable.getTypeName()) as Interactable
    interactable.allowMultipleInteractors = false
    this.manipulation = this.tricycle.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation
    this.manipulation.useFilter = false
    this.manipulation.setCanRotate(false)
    this.manipulation.setCanScale(false)
    this.manipulation.setNewInteractable(interactable)
    this.manipulation.onManipulationStart.add(() => this.onTricycleGrab())
    this.manipulation.onManipulationEnd.add(() => this.onTricycleRelease())
  }

  // Anchored at the dashboard point behind the hood trailing edge, tilted to face the driver's eye.
  private buildCockpit(): void {
    const strip = createChildSceneObjectWithParentLayer("CockpitStrip", this.getSceneObject())
    const t = strip.getTransform()
    const anchor = toVec3(SPEC.dashboardStripLocalPos)
    t.setLocalPosition(anchor)
    t.setLocalRotation(quat.lookAt(toVec3(SPEC.driverEyeLocalPos).sub(anchor).normalize(), vec3.up()))
    this.cockpitStrip = strip

    // Saturated backing bar: on an additive display a coloured text fill alone reads as white.
    const bar = new MeshAccumulator()
    bar.quad(new vec3(-15, 4, -0.3), new vec3(15, 4, -0.3), new vec3(15, 9, -0.3), new vec3(-15, 9, -0.3))
    const barObj = createChildSceneObjectWithParentLayer("StatusBar", strip)
    const barVisual = barObj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    barVisual.mesh = bar.build()
    barVisual.mainMaterial = this.material(COLOR.barIdle)
    this.statusBar = barVisual

    const status = createChildSceneObjectWithParentLayer("StatusLabel", strip)
    status.getTransform().setLocalPosition(new vec3(0, 6.5, 0))
    this.statusLabel = addContentToElement(status, {text: "", textSize: 40, sizeOverride: new vec2(30, 4)})
    this.statusLabel.useTextColorOverride = true
    this.statusLabel.textColorOverride = COLOR.label

    const progress = createChildSceneObjectWithParentLayer("ZoneProgressLabel", strip)
    progress.getTransform().setLocalPosition(new vec3(0, 2, 0))
    this.progressLabel = addContentToElement(progress, {text: "", textSize: 26, sizeOverride: new vec2(30, 3)})

    this.makeButton(strip, "ReadyToDepartButton", "Ready to Depart", new vec3(-5.5, -2.8, 0), new vec3(16, 4.5, 1), "Primary", () =>
      this.onReadyPressed(),
    )
    this.makeButton(strip, "ResetButton", "Reset", new vec3(9.5, -2.8, 0), new vec3(9, 4.5, 1), "Secondary", () =>
      this.onResetPressed(),
    )
  }

  // Floats on the viewer's own sightline so the first-person view names what the beam is doing.
  private buildSightlineLabel(): void {
    const obj = createChildSceneObjectWithParentLayer("SightlineLabel", this.getSceneObject())
    this.sightlineLabel = addContentToElement(obj, {text: "", textSize: 44, sizeOverride: new vec2(40, 5)})
    this.sightlineLabel.useTextColorOverride = true
    this.sightlineLabelObj = obj
  }

  private renderSightlineLabel(eye: vec3): void {
    const s = this.state
    const towardDriver = toVec3(SPEC.driverEyeLocalPos).sub(eye).normalize()
    const pos = eye.add(towardDriver.uniformScale(75)).add(new vec3(0, 9, 0))
    const t = this.sightlineLabelObj.getTransform()
    t.setLocalPosition(pos)
    t.setLocalRotation(quat.lookAt(eye.sub(pos).normalize(), vec3.up()))
    t.setLocalScale(vec3.one().uniformScale(2.5))
    const heightCm = Math.round(eye.y)
    const blocker = s.sightline.hitOccluderId?.includes("pillar") ? "A-PILLAR" : "HOOD"
    const text = s.sightline.clear ? `SIGHTLINE CLEAR (${heightCm} cm)` : `BLOCKED BY ${blocker} (${heightCm} cm)`
    if (text !== this.lastSightlineText) {
      this.lastSightlineText = text
      this.sightlineLabel.text = text
      this.sightlineLabel.textColorOverride = s.sightline.clear ? COLOR.beamClear : COLOR.beamBlocked
    }
  }

  private makeButton(
    parent: SceneObject,
    name: string,
    label: string,
    position: vec3,
    size: vec3,
    style: "Primary" | "Secondary",
    onTrigger: () => void,
  ): void {
    const obj = createChildSceneObjectWithParentLayer(name, parent)
    obj.getTransform().setLocalPosition(position)
    const button = obj.createComponent(Button.getTypeName()) as Button
    button.setVariant({theme: "System3", shape: "Rectangle", style})
    button.size = size
    button.initialize()
    addContentToElement(obj, {text: label, textSize: 40})
    button.onTriggerUp.add(onTrigger)
  }

  private buildAudio(): void {
    const make = (name: string, track: AudioTrackAsset): AudioComponent => {
      const obj = global.scene.createSceneObject(name)
      obj.setParent(this.getSceneObject())
      const audio = obj.createComponent("Component.AudioComponent") as AudioComponent
      audio.audioTrack = track
      return audio
    }
    this.audio = {
      intercept: make("SfxIntercept", this.sfxIntercept),
      zone: make("SfxZoneVerified", this.sfxZoneVerified),
      snap: make("SfxTrikeSnap", this.sfxTrikeSnap),
      depart: make("SfxDepartCleared", this.sfxDepartCleared),
    }
    // User-input feedback cues: LowLatency per the Specs audio guidance (settable only from script).
    this.createEvent("OnStartEvent").bind(() => {
      for (const audio of Object.values(this.audio)) {
        audio.playbackMode = Audio.PlaybackMode.LowLatency
      }
    })
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
    // 3D cross (8 cm arm radius) around a solid core, readable from any viewing angle.
    marker.box(new vec3(-4.5, -4.5, -4.5), new vec3(4.5, 4.5, 4.5))
    marker.box(new vec3(-8, -1.6, -1.6), new vec3(8, 1.6, 1.6))
    marker.box(new vec3(-1.6, -8, -1.6), new vec3(1.6, 8, 1.6))
    marker.box(new vec3(-1.6, -1.6, -8), new vec3(1.6, 1.6, 8))
    this.hitMarker = this.child("SightlineHitMarker", marker.build(), this.material(COLOR.hitMarker, false, true))
    // Disabling the depth test is not enough: the opaque bumper drawn later would still paint over the overlay.
    this.beamVisual.setRenderOrder(100)
    ;(this.hitMarker.getComponent("Component.RenderMeshVisual") as RenderMeshVisual).setRenderOrder(101)
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

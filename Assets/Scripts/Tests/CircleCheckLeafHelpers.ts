import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {findSceneObjectByName, nextFrame} from "Leaf.lspkg/Utils/common/Utils"
import {CircleCheckMain} from "../CircleCheckMain"
import type {BlindSpotZoneId, DebugSnapshot} from "../Core/CircleCheckCore"

export const DRIVER_EYE = new vec3(-45, 152, -195)
export const DASHBOARD = new vec3(-45, 136, -152)

export function getMain(): CircleCheckMain {
  const main = findSceneObjectByName("VehicleRoot").getComponent(
    CircleCheckMain.getTypeName(),
  ) as CircleCheckMain
  if (isNull(main)) {
    throw new Error("CircleCheckMain component not found on VehicleRoot")
  }
  return main
}

export async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await nextFrame()
  }
}

// Moves the viewpoint through the same VehicleRoot-relative pipeline the live camera uses,
// then proves the per-frame camLocalPos actually landed there before any assertion trusts it.
export async function goTo(main: CircleCheckMain, eye: vec3, lookAt: vec3): Promise<DebugSnapshot> {
  main.placeViewpoint(eye, lookAt)
  await frames(3)
  const snap = main.getDebugSnapshot()
  const p = snap.cameraPos
  expect(new vec3(p.x, p.y, p.z).distance(eye) < 1).toBe(true)
  return snap
}

// LEAF drag vectors are world-space; convert a vehicle-local direction through VehicleRoot.
export function vehicleDir(main: CircleCheckMain, local: vec3): vec3 {
  return main.getTransform().getWorldRotation().multiplyVec3(local)
}

export function trikeLocalPos(main: CircleCheckMain): vec3 {
  const world = findSceneObjectByName("Tricycle").getTransform().getWorldPosition()
  return main.getTransform().getInvertedWorldTransform().multiplyPoint(world)
}

export function zoneIsGreen(zone: BlindSpotZoneId): boolean {
  const visual = findSceneObjectByName(`Zone_${zone}`).getComponent("Component.RenderMeshVisual") as RenderMeshVisual
  const c = visual.mainMaterial.mainPass.baseColor as vec4
  return c.g > 0.8 && c.r < 0.5
}

export function log(tag: string, snap: DebugSnapshot): void {
  print(`[CircleCheckLeaf] ${tag} ${JSON.stringify(snap)}`)
}

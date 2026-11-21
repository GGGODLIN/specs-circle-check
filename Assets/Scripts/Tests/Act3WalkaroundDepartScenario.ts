import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {DEFAULT_EVENT_TIMEOUT_MS, findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils"
import {DefaultLeafInteractor} from "Leaf.lspkg/Interactors/interactor/DefaultLeafInteractor"
import {findInteractableByName} from "Leaf.lspkg/Interactors/InteractableUtils"
import {BLIND_SPOT_ZONE_IDS, DEFAULT_VEHICLE_GEOMETRY_SPEC, type BlindSpotZoneId} from "../Core/CircleCheckCore"
import {DASHBOARD, DRIVER_EYE, frames, getMain, goTo, log, trikeLocalPos, vehicleDir, zoneIsGreen} from "./CircleCheckLeafHelpers"

const CHECKPOINT_EYES: Record<BlindSpotZoneId, vec3> = {
  FrontLeftAPillar: new vec3(-135, 160, 90),
  FrontCenterHood: new vec3(0, 160, 160),
  FrontRightAPillar: new vec3(135, 160, 90),
}

// Look targets spread across each zone's footprint, mimicking a head sweep from one checkpoint.
function sweepTargets(zone: BlindSpotZoneId): vec3[] {
  const main = getMain()
  const {cells, zoneCellIndices} = main.getFootprint()
  const zoneCells = zoneCellIndices[zone].map((i) => cells[i])
  const xs = zoneCells.map((c) => c.centerX)
  const zs = zoneCells.map((c) => c.centerZ)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const z0 = Math.min(...zs)
  const z1 = Math.max(...zs)
  const out: vec3[] = []
  for (const fx of [0.15, 0.5, 0.85]) {
    for (const fz of [0.1, 0.4, 0.7, 0.95]) {
      out.push(new vec3(x0 + (x1 - x0) * fx, 0, z0 + (z1 - z0) * fz))
    }
  }
  return out
}

// LEAF Scenario 3 — walkaround sweep flips all zones, a close unoccluded drag parks the tricycle,
// departure clears from the cab, and Reset leaves no residue.
@component
export class Act3WalkaroundDepartScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(500)
    const main = getMain()
    const interactor = new DefaultLeafInteractor()
    interactor.eventTimeoutMs = DEFAULT_EVENT_TIMEOUT_MS

    for (const zone of BLIND_SPOT_ZONE_IDS) {
      const eye = CHECKPOINT_EYES[zone]
      await goTo(main, eye, sweepTargets(zone)[0])
      expect(findSceneObjectByName(`Beacon_${zone}`).enabled).toBe(true)
      for (const target of sweepTargets(zone)) {
        main.placeViewpoint(eye, target)
        await frames(2)
      }
      const snap = main.getDebugSnapshot()
      log(`act3-swept-${zone}`, snap)
      expect(snap.zoneVerified[zone]).toBe(true)
      expect(zoneIsGreen(zone)).toBe(true)
      expect(findSceneObjectByName(`Beacon_${zone}`).enabled).toBe(false)
    }
    expect(main.getDebugSnapshot().allZonesVerified).toBe(true)

    const trikeStart = DEFAULT_VEHICLE_GEOMETRY_SPEC.tricycle.initialPos
    await goTo(main, new vec3(15, 160, 150), new vec3(trikeStart.x, 25, trikeStart.z))
    await interactor.drag(findInteractableByName("Tricycle"), vehicleDir(main, new vec3(4, 0, 0.5)), 900)
    await frames(5)
    const parked = main.getDebugSnapshot()
    log("act3-trike-parked", parked)
    expect(parked.lastRejectReason).toBeNull()
    expect(parked.isTricycleCleared).toBe(true)
    expect(parked.tricyclePos.x).toBe(150)
    expect(parked.tricyclePos.z).toBe(70)
    const visual = trikeLocalPos(main)
    expect(visual.distance(new vec3(150, 0, 70)) < 0.5).toBe(true)

    await goTo(main, DRIVER_EYE, DASHBOARD)
    await interactor.trigger(findInteractableByName("ReadyToDepartButton"))
    await frames(3)
    const cleared = main.getDebugSnapshot()
    log("act3-cleared", cleared)
    expect(cleared.departureStatus).toBe("CLEARED")
    expect(cleared.canDepart).toBe(true)

    await interactor.trigger(findInteractableByName("ResetButton"))
    await frames(3)
    const reset = main.getDebugSnapshot()
    log("act3-reset", reset)
    expect(reset.departureStatus).toBe("IDLE")
    expect(reset.allZonesVerified).toBe(false)
    expect(reset.tricyclePos.x).toBe(15)
    expect(reset.tricyclePos.z).toBe(55)
    expect(reset.isTricycleCleared).toBe(false)
    expect(trikeLocalPos(main).distance(new vec3(15, 0, 55)) < 0.5).toBe(true)
    for (const zone of BLIND_SPOT_ZONE_IDS) {
      expect(reset.zoneVerified[zone]).toBe(false)
      expect(zoneIsGreen(zone)).toBe(false)
      expect(findSceneObjectByName(`Beacon_${zone}`).enabled).toBe(false)
    }
  }
}

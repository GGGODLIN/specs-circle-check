import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {DEFAULT_EVENT_TIMEOUT_MS, findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils"
import {DefaultLeafInteractor} from "Leaf.lspkg/Interactors/interactor/DefaultLeafInteractor"
import {findInteractableByName} from "Leaf.lspkg/Interactors/InteractableUtils"
import {BLIND_SPOT_ZONE_IDS} from "../Core/CircleCheckCore"
import {DRIVER_EYE, DASHBOARD, frames, getMain, goTo, log, trikeLocalPos, vehicleDir} from "./CircleCheckLeafHelpers"

// LEAF Scenario 2 — departure is blocked from the cab, and the tricycle cannot be dragged through the hood
// even though the scripted LEAF ray reaches its collider (no collider on the hood by design).
@component
export class Act2BlockedDepartureScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(500)
    const main = getMain()
    const interactor = new DefaultLeafInteractor()
    interactor.eventTimeoutMs = DEFAULT_EVENT_TIMEOUT_MS

    const seat = await goTo(main, DRIVER_EYE, DASHBOARD)
    expect(seat.inDriverSeat).toBe(true)
    expect(seat.departureStatus).toBe("IDLE")
    expect(findSceneObjectByName("CockpitStrip").enabled).toBe(true)

    await interactor.trigger(findInteractableByName("ReadyToDepartButton"))
    await frames(3)
    const blocked = main.getDebugSnapshot()
    log("act2-blocked", blocked)
    expect(blocked.departureStatus).toBe("BLOCKED")
    expect(blocked.walkaroundBeaconsActive).toBe(true)
    for (const zone of BLIND_SPOT_ZONE_IDS) {
      expect(findSceneObjectByName(`Beacon_${zone}`).enabled).toBe(true)
    }

    const before = trikeLocalPos(main)
    await interactor.drag(findInteractableByName("Tricycle"), vehicleDir(main, new vec3(3, 0, 0)), 600)
    await frames(5)
    const guarded = main.getDebugSnapshot()
    log("act2-through-hood-drag", guarded)
    expect(guarded.isTricycleCleared).toBe(false)
    expect(guarded.lastRejectReason !== null).toBe(true)
    expect(guarded.tricyclePos.x).toBe(15)
    expect(guarded.tricyclePos.z).toBe(55)
    expect(trikeLocalPos(main).distance(before) < 0.5).toBe(true)
    expect(guarded.departureStatus).toBe("BLOCKED")
  }
}

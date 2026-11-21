import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils"
import {getMain, goTo, log} from "./CircleCheckLeafHelpers"

// LEAF Scenario 1 — sightline reciprocity 100 cm ahead of the bumper: standing sees the driver, crouching does not.
@component
export class Act1SightlineScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(500)
    const main = getMain()
    const driverEye = new vec3(-45, 152, -195)

    const standing = await goTo(main, new vec3(-45, 160, 100), driverEye)
    log("act1-standing", standing)
    expect(standing.sightlineBlocked).toBe(false)
    expect(standing.inDriverSeat).toBe(false)
    expect(findSceneObjectByName("SightlineBeam").enabled).toBe(true)
    expect(findSceneObjectByName("SightlineHitMarker").enabled).toBe(false)

    const crouched = await goTo(main, new vec3(-45, 70, 100), driverEye)
    log("act1-crouched", crouched)
    expect(crouched.sightlineBlocked).toBe(true)
    expect(crouched.sightlineHitOccluderId !== null).toBe(true)
    expect(findSceneObjectByName("SightlineBeam").enabled).toBe(true)
    expect(findSceneObjectByName("SightlineHitMarker").enabled).toBe(true)
  }
}

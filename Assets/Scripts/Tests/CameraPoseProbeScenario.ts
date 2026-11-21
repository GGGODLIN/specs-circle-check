import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {findSceneObjectByName, nextFrame, sleep} from "Leaf.lspkg/Utils/common/Utils"

// Ticket 01 gate: decides whether LEAF may drive the Preview camera directly, or whether
// DeviceTracking overwrites it every frame so scenarios must move VehicleRoot instead.
@component
export class CameraPoseProbeScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(500)
    const transform = findSceneObjectByName("Camera Object").getTransform()
    const before = transform.getWorldPosition()
    const target = before.add(new vec3(-45, -90, 100))
    const targetRot = quat.fromEulerAngles(0, Math.PI / 6, 0)

    transform.setWorldPosition(target)
    transform.setWorldRotation(targetRot)

    const samples: {frame: number; dist: number; rotDot: number}[] = []
    let frame = 0
    for (const checkpoint of [1, 2, 5, 30, 90]) {
      while (frame < checkpoint) {
        await nextFrame()
        frame += 1
      }
      samples.push({
        frame,
        dist: transform.getWorldPosition().distance(target),
        rotDot: Math.abs(transform.getWorldRotation().dot(targetRot)),
      })
    }

    const persisted = samples.every((s) => s.dist < 1 && s.rotDot > 0.999)
    const verdict = persisted ? "direct-camera-ok" : "vehicle-root-inverse-required"
    print(
      "[CameraPoseProbe] " +
        JSON.stringify({
          verdict,
          before: {x: before.x, y: before.y, z: before.z},
          target: {x: target.x, y: target.y, z: target.z},
          samples,
        }),
    )
  }
}

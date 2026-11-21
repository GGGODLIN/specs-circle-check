import {scenariosIndex} from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator"
import {ScenarioMetadata} from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata"
import {Act1SightlineScenario} from "./Act1SightlineScenario"
import {CameraPoseProbeScenario} from "./CameraPoseProbeScenario"

@component
export class LeafIndex extends BaseScriptComponent {
  @scenariosIndex
  static scenariosIndex: ScenarioMetadata[] = [
    {id: "probe-camera-pose", typename: CameraPoseProbeScenario.getTypeName()},
    {id: "act1-sightline-reciprocity", typename: Act1SightlineScenario.getTypeName()},
  ]
}

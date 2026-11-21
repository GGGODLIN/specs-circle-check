import {scenariosIndex} from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator"
import {ScenarioMetadata} from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata"
import {Act1SightlineScenario} from "./Act1SightlineScenario"
import {Act2BlockedDepartureScenario} from "./Act2BlockedDepartureScenario"
import {Act3WalkaroundDepartScenario} from "./Act3WalkaroundDepartScenario"

@component
export class LeafIndex extends BaseScriptComponent {
  @scenariosIndex
  static scenariosIndex: ScenarioMetadata[] = [
    {id: "act1-sightline-reciprocity", typename: Act1SightlineScenario.getTypeName()},
    {id: "act2-blocked-departure-guard", typename: Act2BlockedDepartureScenario.getTypeName()},
    {id: "act3-walkaround-trike-depart", typename: Act3WalkaroundDepartScenario.getTypeName()},
  ]
}

import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import { forcedPrefabricatedViaFixture } from "../tests/fixtures/forced-prefabricated-via";

export default function FixedViaRouterFixture() {
  return (
    <GenericSolverDebugger
      createSolver={() =>
        new BiscuitBoardRoutingPipelineSolver(forcedPrefabricatedViaFixture)
      }
      animationSpeed={30}
    />
  );
}

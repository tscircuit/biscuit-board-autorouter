import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import { forcedPrefabricatedViaFixture } from "../tests/fixtures/forced-prefabricated-via";

/** Simplified example: the only possible layer change is the prefab via. */
export default function Example01Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Example 01 · Forced prefabricated via</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          A small synthetic problem whose top-layer terminal can reach the
          bottom-layer terminal only through the assignable via at (0, 4).
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() =>
          new BiscuitBoardRoutingPipelineSolver(forcedPrefabricatedViaFixture)
        }
        animationSpeed={30}
      />
    </div>
  );
}

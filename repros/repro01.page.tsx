import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "./fixtures/repro01-biscuit-board-stm32.srj.json";

const input = capturedInput as SimpleRouteJson;
const assignableViaCount = input.obstacles.filter(
  (obstacle) => obstacle.netIsAssignable,
).length;

/**
 * Real-project repro captured at BiscuitBoard's algorithmFn boundary.
 * This is the complete STM32C071FBP6 board problem, without simplification.
 */
export default function Repro01Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Repro 01 · BiscuitBoard STM32C071FBP6</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          Exact SRJ captured from tscircuit/biscuit-boards ·
          {` ${input.connections.length} connections · ${input.obstacles.length} obstacles · ${assignableViaCount} prefabricated vias`}
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() => new BiscuitBoardRoutingPipelineSolver(input)}
        animationSpeed={30}
      />
    </div>
  );
}

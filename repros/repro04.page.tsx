import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "./fixtures/repro04-stm32-display-buttons.srj.json";

const input = capturedInput as SimpleRouteJson;
const routeDemandCount = input.connections.reduce(
  (count, connection) =>
    count + Math.max(0, connection.pointsToConnect.length - 1),
  0,
);

/**
 * Exact display-board problem captured from tscircuit/biscuit-boards at the
 * algorithmFn boundary. Repro 04 focuses on irregular BTN1/BTN2 routing.
 */
export default function Repro04Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Repro 04 · STM32 display board BTN1/BTN2 traces</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          Exact SRJ captured from tscircuit/biscuit-boards ·
          {` ${input.connections.length} connections · ${routeDemandCount} routing demands · ${input.obstacles.length} obstacles`}
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() => new BiscuitBoardRoutingPipelineSolver(input)}
        animationSpeed={30}
      />
    </div>
  );
}

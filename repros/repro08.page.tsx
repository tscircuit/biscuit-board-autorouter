import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "./fixtures/repro08-stm32-stepper-stray-traces.srj.json";

const input = capturedInput as SimpleRouteJson;
const routeDemandCount = input.connections.reduce(
  (count, connection) =>
    count + Math.max(0, connection.pointsToConnect.length - 1),
  0,
);

/** Exact stepper-controller input whose VM route leaves a dead-end branch. */
export default function Repro08Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Repro 08 · STM32 stepper stray traces</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          Exact SRJ captured from tscircuit/biscuit-boards ·
          {` ${input.connections.length} connections · ${routeDemandCount} routing demands · ${input.obstacles.length} obstacles`}
        </div>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          The captured source_net_1 route previously left a top-layer branch at
          (-15.8, 18.5375), where there was no terminal or same-net junction.
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() =>
          new BiscuitBoardRoutingPipelineSolver(input, {
            routeOrder: "adaptive",
            gridClearance: 0.1,
            maxBlockersPerSearch: 512,
            maxRipsPerRoute: 1_024,
            maxTotalRips: 50_000,
            maxSearchStates: 10_000_000,
          })
        }
        animationSpeed={30}
      />
    </div>
  );
}

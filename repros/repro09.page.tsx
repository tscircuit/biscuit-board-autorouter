import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "./fixtures/repro09-rp2040-bootsel-dangling-trace.srj.json";

const input = capturedInput as SimpleRouteJson;
const routeDemandCount = input.connections.reduce(
  (count, connection) =>
    count + Math.max(0, connection.pointsToConnect.length - 1),
  0,
);

/** Exact RP2040 photodiode input whose BOOTSEL GND route has a dead end. */
export default function Repro09Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Repro 09 · RP2040 BOOTSEL dangling trace</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          Exact SRJ captured from tscircuit/biscuit-boards ·
          {` ${input.connections.length} connections · ${routeDemandCount} routing demands · ${input.obstacles.length} obstacles`}
        </div>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          The source_net_0 branch from SW_BOOTSEL ends at (18.625, -3.625)
          without reaching another GND trace.
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() =>
          new BiscuitBoardRoutingPipelineSolver(input, {
            gridClearance: 0.1,
            expandTraces: true,
            maxBlockersPerSearch: 1_024,
            maxRipsPerRoute: 1_000,
            maxTotalRips: 10_000,
            maxSearchStates: 2_000_000,
            routeOrder: "input",
          })
        }
        animationSpeed={30}
      />
    </div>
  );
}

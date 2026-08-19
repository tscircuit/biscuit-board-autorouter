import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "./fixtures/repro07-rp2040-c-flash-overlap.srj.json";

const input = capturedInput as SimpleRouteJson;
const routeDemandCount = input.connections.reduce(
  (count, connection) =>
    count + Math.max(0, connection.pointsToConnect.length - 1),
  0,
);

/**
 * Exact RP2040 photodiode-board problem captured from
 * tscircuit/biscuit-boards. Repro 07 focuses on the C_FLASH route underneath
 * the U_FLASH body, where routing completes without reporting a clearance
 * error.
 */
export default function Repro07Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Repro 07 · RP2040 C_FLASH route underneath U_FLASH</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          Exact SRJ captured from tscircuit/biscuit-boards ·
          {` ${input.connections.length} connections · ${routeDemandCount} routing demands · ${input.obstacles.length} obstacles`}
        </div>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          The route between C_FLASH and U_FLASH crosses the flash chip's body
          area, but the completed route has no reported trace-clearance
          violation.
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

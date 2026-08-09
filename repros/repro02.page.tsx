import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "./fixtures/repro02-biscuit-board-rp2040.srj.json";

const input = capturedInput as SimpleRouteJson;
const prefabricatedViaCount = input.obstacles.filter(
  (obstacle) =>
    obstacle.netIsAssignable &&
    obstacle.connectedTo.some((id) => id.startsWith("pcb_via")),
).length;
const routeDemandCount = input.connections.reduce(
  (count, connection) =>
    count + Math.max(0, connection.pointsToConnect.length - 1),
  0,
);

/**
 * Exact RP2040 problem captured from tscircuit/biscuit-boards at the
 * algorithmFn boundary. It uses the complete @tscircuit/common design and the
 * parent BiscuitBoard's prefabricated via field.
 */
export default function Repro02Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Repro 02 · BiscuitBoard RP2040</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          Exact SRJ captured from tscircuit/biscuit-boards ·
          {` ${input.connections.length} connections · ${routeDemandCount} routing demands · ${input.obstacles.length} obstacles · ${prefabricatedViaCount} prefabricated vias`}
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() =>
          new BiscuitBoardRoutingPipelineSolver(input, {
            gridClearance: 0.1,
            maxRipsPerRoute: 1_000,
            maxTotalRips: 10_000,
          })
        }
        animationSpeed={30}
      />
    </div>
  );
}

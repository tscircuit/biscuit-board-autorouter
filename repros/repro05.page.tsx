import type { SimpleRouteJson } from "@tscircuit/core";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "./fixtures/repro05-stm32-display-redundant-gnd-branch.srj.json";

const input = capturedInput as SimpleRouteJson;
const routeDemandCount = input.connections.reduce(
  (count, connection) =>
    count + Math.max(0, connection.pointsToConnect.length - 1),
  0,
);

/**
 * Exact display-board problem captured from tscircuit/biscuit-boards at the
 * normalized BiscuitBoardAutorouter boundary. Repro 05 focuses on the
 * redundant same-net branch from C_MCU to the via above D_PWR.
 */
export default function Repro05Page() {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header style={{ padding: "12px 16px" }}>
        <strong>Repro 05 · STM32 display redundant GND branch</strong>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          Exact SRJ captured from tscircuit/biscuit-boards ·
          {` ${input.connections.length} connections · ${routeDemandCount} routing demands · ${input.obstacles.length} obstacles`}
        </div>
        <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
          C_MCU is already connected through C_NRST and D_PWR when its GND
          branch crosses the via route; the copper between C_MCU and that
          crossing is redundant.
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() => new BiscuitBoardRoutingPipelineSolver(input)}
        animationSpeed={30}
      />
    </div>
  );
}

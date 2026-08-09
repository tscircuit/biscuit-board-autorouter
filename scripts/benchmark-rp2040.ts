import type { SimpleRouteJson } from "@tscircuit/core";
import {
  BiscuitBoardRoutingPipelineSolver,
  getTraceClearanceViolations,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import capturedInput from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";

const input = capturedInput as SimpleRouteJson;
const maxMsArgument = process.argv.find((argument) =>
  argument.startsWith("--max-ms="),
);
const routeOrderArgument = process.argv.find((argument) =>
  argument.startsWith("--route-order="),
);
const maximumRuntimeMs = Number(maxMsArgument?.split("=")[1] ?? 120_000);
const routeOrder = (routeOrderArgument?.split("=")[1] ?? "input") as
  | "input"
  | "longest_first"
  | "shortest_first";
const jsonOnly = process.argv.includes("--json");
const includeDebugState = process.argv.includes("--debug");

if (!Number.isFinite(maximumRuntimeMs) || maximumRuntimeMs <= 0) {
  throw new Error("--max-ms must be a positive number");
}
if (!["input", "longest_first", "shortest_first"].includes(routeOrder)) {
  throw new Error(
    "--route-order must be input, longest_first, or shortest_first",
  );
}

const solver = new BiscuitBoardRoutingPipelineSolver(input, {
  gridClearance: 0.1,
  maxRipsPerRoute: 1_000,
  maxTotalRips: 10_000,
  routeOrder,
});
const startedAt = performance.now();
let nextProgressAt = 10_000;

while (
  !solver.solved &&
  !solver.failed &&
  performance.now() - startedAt < maximumRuntimeMs
) {
  solver.step();
  const elapsedMs = performance.now() - startedAt;
  if (!jsonOnly && elapsedMs >= nextProgressAt) {
    const routeSolver = solver.getSolver("route-with-rip-and-replace");
    process.stderr.write(
      `[rp2040] ${(elapsedMs / 1_000).toFixed(1)}s · ${solver.stage} · ${JSON.stringify(routeSolver?.stats ?? {})}\n`,
    );
    nextProgressAt += 10_000;
  }
}

const output = solver.getOutput();
const prepared = solver.getStageOutput<PreparedBiscuitRoutingProblem>(
  "generate-hypergraph",
);
const clearanceViolations =
  prepared && output ? getTraceClearanceViolations(prepared, output) : [];
const manufacturedViaCount =
  output?.traces
    .flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via").length ?? 0;
const routeSolver = solver.getSolver("route-with-rip-and-replace");
const routeSolverDebug = routeSolver as unknown as {
  getConflictComponents?: () => string[][];
  getDisconnectedDemands?: () => Array<{ routeId: string; netId: string }>;
  pending?: Array<{ routeId: string }>;
};
const report = {
  fixture: "repros/fixtures/repro02-biscuit-board-rp2040.srj.json",
  elapsedMs: Math.round(performance.now() - startedAt),
  routeOrder,
  solved: solver.solved,
  failed: solver.failed,
  error: solver.error ?? null,
  stage: solver.stage,
  connectionCount: input.connections.length,
  obstacleCount: input.obstacles.length,
  prefabricatedViaCount: input.obstacles.filter(
    (obstacle) =>
      obstacle.netIsAssignable &&
      obstacle.connectedTo.some((id) => id.startsWith("pcb_via")),
  ).length,
  traceCount: output?.traces.length ?? 0,
  manufacturedViaCount,
  clearanceViolationCount: clearanceViolations.length,
  stats: output?.stats ?? routeSolver?.stats,
  ...(includeDebugState
    ? {
        conflictComponents: routeSolverDebug.getConflictComponents?.(),
        disconnectedDemands: routeSolverDebug
          .getDisconnectedDemands?.()
          .map(({ routeId, netId }) => ({ routeId, netId })),
        pendingRouteIds: routeSolverDebug.pending?.map(
          ({ routeId }) => routeId,
        ),
      }
    : {}),
};

console.log(JSON.stringify(report, null, 2));

if (
  !solver.solved ||
  solver.failed ||
  !output ||
  output.traces.length < 97 ||
  manufacturedViaCount !== 0 ||
  clearanceViolations.length !== 0
) {
  process.exitCode = 1;
}

import type { SimpleRouteJson } from "@tscircuit/core";
import {
  BiscuitBoardRoutingPipelineSolver,
  getTraceClearanceViolations,
  type BiscuitBoardRoutingSolution,
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
const gridPitchArgument = process.argv.find((argument) =>
  argument.startsWith("--grid-pitch="),
);
const viaCostArgument = process.argv.find((argument) =>
  argument.startsWith("--via-cost="),
);
const writeBuiltArgument = process.argv.find((argument) =>
  argument.startsWith("--write-built="),
);
const writeSolvedArgument = process.argv.find((argument) =>
  argument.startsWith("--write-solved="),
);
const maximumRuntimeMs = Number(maxMsArgument?.split("=")[1] ?? 300_000);
const gridPitch = Number(gridPitchArgument?.split("=")[1] ?? 1.5);
const viaTransitionCost = Number(viaCostArgument?.split("=")[1] ?? 20);
const routeOrder = (routeOrderArgument?.split("=")[1] ??
  "signal_longest_first") as
  | "input"
  | "longest_first"
  | "shortest_first"
  | "signal_longest_first";
const jsonOnly = process.argv.includes("--json");
const includeDebugState = process.argv.includes("--debug");

if (!Number.isFinite(maximumRuntimeMs) || maximumRuntimeMs <= 0) {
  throw new Error("--max-ms must be a positive number");
}
if (!Number.isFinite(gridPitch) || gridPitch <= 0) {
  throw new Error("--grid-pitch must be a positive number");
}
if (!Number.isFinite(viaTransitionCost) || viaTransitionCost <= 0) {
  throw new Error("--via-cost must be a positive number");
}
if (
  ![
    "input",
    "longest_first",
    "shortest_first",
    "signal_longest_first",
  ].includes(routeOrder)
) {
  throw new Error(
    "--route-order must be input, longest_first, shortest_first, or signal_longest_first",
  );
}

const solver = new BiscuitBoardRoutingPipelineSolver(input, {
  gridClearance: 0.1,
  gridPitch,
  viaTransitionCost,
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
    const compactConflicts = (
      routeSolver as unknown as {
        negotiationConflictComponents?: string[][];
      }
    )?.negotiationConflictComponents?.filter(
      (component) => component.length <= 4,
    );
    process.stderr.write(
      `[rp2040] ${(elapsedMs / 1_000).toFixed(1)}s · ${solver.stage} · ${JSON.stringify({ ...(routeSolver?.stats ?? {}), ...(compactConflicts?.length ? { compactConflicts } : {}) })}\n`,
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
const built = solver.getStageOutput<BiscuitBoardRoutingSolution>(
  "build-and-validate-traces",
);
const routeSolverDebug = routeSolver as unknown as {
  getConflictComponents?: () => string[][];
  getDisconnectedDemands?: () => Array<{ routeId: string; netId: string }>;
  getForeignOwners?: (
    edge: PreparedBiscuitRoutingProblem["edges"][number],
    demand: PreparedBiscuitRoutingProblem["demands"][number],
  ) => string[];
  committed?: Map<
    string,
    { routeId: string; edgePath: number[]; nodePath: number[] }
  >;
  pending?: Array<{ routeId: string }>;
};
const conflictDetails =
  includeDebugState && prepared
    ? [...(routeSolverDebug.committed?.values() ?? [])]
        .flatMap((route) => {
          const demand = prepared.demandById.get(route.routeId);
          if (!demand) return [];
          return route.edgePath.flatMap((edgeId) => {
            const edge = prepared.edges[edgeId]!;
            const foreignRouteIds =
              routeSolverDebug.getForeignOwners?.(edge, demand) ?? [];
            if (foreignRouteIds.length === 0) return [];
            return [
              {
                routeId: route.routeId,
                foreignRouteIds,
                kind: edge.kind,
                from: prepared.nodes[edge.fromNode],
                to: prepared.nodes[edge.toNode],
              },
            ];
          });
        })
        .slice(0, 100)
    : [];
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
        conflictDetails,
      }
    : {}),
};

console.log(JSON.stringify(report, null, 2));

if (solver.solved && built && writeBuiltArgument) {
  await Bun.write(
    writeBuiltArgument.slice("--write-built=".length),
    `${JSON.stringify(built, null, 2)}\n`,
  );
}
if (solver.solved && output && writeSolvedArgument) {
  await Bun.write(
    writeSolvedArgument.slice("--write-solved=".length),
    `${JSON.stringify(output, null, 2)}\n`,
  );
}

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

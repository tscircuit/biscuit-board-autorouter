import type { SimpleRouteJson } from "@tscircuit/core";
import {
  BiscuitBoardRoutingPipelineSolver,
  getTraceClearanceViolations,
  type BiscuitBoardAutorouterOptions,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import stm32Input from "../repros/fixtures/repro01-biscuit-board-stm32.srj.json";
import rp2040Input from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";
import stm32DisplayInput from "../repros/fixtures/repro03-stm32-display-user-led.srj.json";
import stm32DisplayBoosterPackInput from "../repros/fixtures/repro06-stm32-display-boosterpack.srj.json";

type BenchmarkOptions = Omit<BiscuitBoardAutorouterOptions, "routeOrder">;

interface BenchmarkCase {
  id: string;
  name: string;
  fixture: string;
  input: SimpleRouteJson;
  options: BenchmarkOptions;
}

const benchmarkCases: BenchmarkCase[] = [
  {
    id: "stm32",
    name: "BiscuitBoard STM32C071FBP6",
    fixture: "repros/fixtures/repro01-biscuit-board-stm32.srj.json",
    input: stm32Input as SimpleRouteJson,
    options: {},
  },
  {
    id: "stm32-display",
    name: "STM32C071 display board",
    fixture: "repros/fixtures/repro03-stm32-display-user-led.srj.json",
    input: stm32DisplayInput as SimpleRouteJson,
    options: {},
  },
  {
    id: "stm32-display-boosterpack",
    name: "STM32C071 display BoosterPack",
    fixture: "repros/fixtures/repro06-stm32-display-boosterpack.srj.json",
    input: stm32DisplayBoosterPackInput as SimpleRouteJson,
    options: {
      gridClearance: 0.1,
      gridPitch: 1,
      maxBlockersPerSearch: 128,
      maxRipsPerRoute: 1_000,
      maxSearchStates: 2_000_000,
      maxTotalRips: 10_000,
    },
  },
  {
    id: "rp2040",
    name: "BiscuitBoard RP2040",
    fixture: "repros/fixtures/repro02-biscuit-board-rp2040.srj.json",
    input: rp2040Input as SimpleRouteJson,
    options: {
      gridClearance: 0.1,
      maxRipsPerRoute: 1_000,
      maxTotalRips: 10_000,
    },
  },
];

const usage = `Usage: ./benchmark.sh [options]

Options:
  --case=<id>        Run one case; may be repeated
  --max-ms=<number>  Maximum runtime per case (default: 180000)
  --progress-ms=<n>  Progress interval (default: 10000)
  --debug            Include conflict and connectivity details
  --json             Suppress human-readable progress
  --list             List benchmark case IDs
  --help             Show this help

The suite intentionally does not accept a route-order option. Every case omits
routeOrder so the autorouter's default is measured.`;

const valueArguments = new Set(["--case", "--max-ms", "--progress-ms"]);
const flagArguments = new Set(["--debug", "--json", "--list", "--help"]);

for (const argument of process.argv.slice(2)) {
  const [name] = argument.split("=", 1);
  if (!flagArguments.has(argument) && !valueArguments.has(name!)) {
    throw new Error(`Unknown argument: ${argument}\n\n${usage}`);
  }
  if (valueArguments.has(name!) && !argument.includes("=")) {
    throw new Error(`${name} requires a value\n\n${usage}`);
  }
}

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

if (process.argv.includes("--list")) {
  for (const benchmarkCase of benchmarkCases) {
    console.log(`${benchmarkCase.id}\t${benchmarkCase.name}`);
  }
  process.exit(0);
}

const getNumericArgument = (name: string, fallback: number) => {
  const argument = process.argv.find((candidate) =>
    candidate.startsWith(`${name}=`),
  );
  const value = Number(argument?.slice(name.length + 1) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
};

const maximumRuntimeMs = getNumericArgument("--max-ms", 180_000);
const progressIntervalMs = getNumericArgument("--progress-ms", 10_000);
const jsonOnly = process.argv.includes("--json");
const includeDebugState = process.argv.includes("--debug");
const requestedCaseIds = process.argv
  .filter((argument) => argument.startsWith("--case="))
  .map((argument) => argument.slice("--case=".length));
const unknownCaseIds = requestedCaseIds.filter(
  (id) => !benchmarkCases.some((benchmarkCase) => benchmarkCase.id === id),
);
if (unknownCaseIds.length > 0) {
  throw new Error(
    `Unknown benchmark case(s): ${unknownCaseIds.join(", ")}. Run ./benchmark.sh --list.`,
  );
}
const selectedCases =
  requestedCaseIds.length === 0
    ? benchmarkCases
    : benchmarkCases.filter((benchmarkCase) =>
        requestedCaseIds.includes(benchmarkCase.id),
      );

const countPrefabricatedVias = (input: SimpleRouteJson) =>
  input.obstacles.filter(
    (obstacle) =>
      obstacle.netIsAssignable &&
      obstacle.connectedTo.some((id) => id.startsWith("pcb_via")),
  ).length;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const runBenchmarkCase = (benchmarkCase: BenchmarkCase) => {
  const solver = new BiscuitBoardRoutingPipelineSolver(
    benchmarkCase.input,
    benchmarkCase.options,
  );
  const startedAt = performance.now();
  let nextProgressAt = progressIntervalMs;
  let thrownError: string | null = null;
  let peakCommittedDemandCount = 0;
  let peakCommittedDemandElapsedMs = 0;
  const stageDurationsMs = new Map<string, number>();

  if (!jsonOnly) {
    process.stderr.write(
      `[${benchmarkCase.id}] starting ${benchmarkCase.name}\n`,
    );
  }

  try {
    while (
      !solver.solved &&
      !solver.failed &&
      performance.now() - startedAt < maximumRuntimeMs
    ) {
      const stage = solver.stage;
      const stepStartedAt = performance.now();
      solver.step();
      const elapsedMs = performance.now() - startedAt;
      stageDurationsMs.set(
        stage,
        (stageDurationsMs.get(stage) ?? 0) +
          (performance.now() - stepStartedAt),
      );
      const currentCommittedDemandCount =
        solver.getSolver("route-with-rip-and-replace")?.stats?.routedCount ?? 0;
      if (currentCommittedDemandCount > peakCommittedDemandCount) {
        peakCommittedDemandCount = currentCommittedDemandCount;
        peakCommittedDemandElapsedMs = elapsedMs;
      }
      if (!jsonOnly && elapsedMs >= nextProgressAt) {
        const routeSolver = solver.getSolver("route-with-rip-and-replace");
        process.stderr.write(
          `[${benchmarkCase.id}] ${(elapsedMs / 1_000).toFixed(1)}s · ${solver.stage} · ${JSON.stringify(routeSolver?.stats ?? {})}\n`,
        );
        nextProgressAt += progressIntervalMs;
      }
    }
  } catch (error) {
    thrownError = getErrorMessage(error);
  }

  const elapsedMs = performance.now() - startedAt;
  const timedOut =
    !solver.solved &&
    !solver.failed &&
    !thrownError &&
    elapsedMs >= maximumRuntimeMs;
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
    getDisconnectedDemands?: () => Array<{
      routeId: string;
      netId: string;
    }>;
    pending?: Array<{ routeId: string }>;
  };
  const expectedTraceCount = prepared?.demands.length ?? null;
  const routedDemandCount =
    output?.stats.routedCount ?? routeSolver?.stats.routedCount ?? 0;
  const pendingDemandCount =
    output?.stats.pendingCount ?? routeSolver?.stats.pendingCount ?? null;
  const passed = Boolean(
    solver.solved &&
      !solver.failed &&
      !thrownError &&
      !timedOut &&
      output &&
      expectedTraceCount !== null &&
      output.traces.length === expectedTraceCount &&
      manufacturedViaCount === 0 &&
      clearanceViolations.length === 0,
  );
  const report = {
    id: benchmarkCase.id,
    name: benchmarkCase.name,
    fixture: benchmarkCase.fixture,
    passed,
    elapsedMs: Math.round(elapsedMs),
    timedOut,
    solved: solver.solved,
    failed: solver.failed,
    error: thrownError ?? (solver.error ? getErrorMessage(solver.error) : null),
    stage: solver.stage,
    stageDurationsMs: Object.fromEntries(
      [...stageDurationsMs].map(([stage, durationMs]) => [
        stage,
        Math.round(durationMs),
      ]),
    ),
    configuredOptions: benchmarkCase.options,
    effectiveRouteOrder: prepared?.options.routeOrder ?? null,
    connectionCount: benchmarkCase.input.connections.length,
    obstacleCount: benchmarkCase.input.obstacles.length,
    prefabricatedViaCount: countPrefabricatedVias(benchmarkCase.input),
    expectedTraceCount,
    peakCommittedDemandCount,
    peakCommittedDemandElapsedMs: Math.round(peakCommittedDemandElapsedMs),
    routedDemandCount,
    pendingDemandCount,
    traceCount: output?.traces.length ?? 0,
    manufacturedViaCount,
    clearanceViolationCount: clearanceViolations.length,
    stats: output?.stats ?? routeSolver?.stats ?? null,
    ...(includeDebugState
      ? {
          conflictComponents: routeSolverDebug.getConflictComponents?.() ?? [],
          disconnectedDemands:
            routeSolverDebug.getDisconnectedDemands?.() ?? [],
          pendingRouteIds:
            routeSolverDebug.pending?.map(({ routeId }) => routeId) ?? [],
        }
      : {}),
  };

  if (!jsonOnly) {
    process.stderr.write(
      `[${benchmarkCase.id}] ${passed ? "passed" : "failed"} in ${(elapsedMs / 1_000).toFixed(1)}s · ${routedDemandCount}/${expectedTraceCount ?? "?"} demands routed · default order ${prepared?.options.routeOrder ?? "unavailable"}\n`,
    );
  }

  return report;
};

const results = selectedCases.map(runBenchmarkCase);
const report = {
  passed: results.every((result) => result.passed),
  routeOrderSource: "autorouter-default",
  maximumRuntimeMsPerCase: maximumRuntimeMs,
  caseCount: results.length,
  passedCaseCount: results.filter((result) => result.passed).length,
  failedCaseCount: results.filter((result) => !result.passed).length,
  totalElapsedMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
  cases: results,
};

console.log(JSON.stringify(report, null, 2));

if (!report.passed) process.exitCode = 1;

import type { SimpleRouteJson } from "@tscircuit/core";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  BiscuitBoardAutorouterOptions,
  BiscuitBoardRoutingStats,
  PreparedBiscuitRoutingProblem,
} from "../lib";
import rp2040Input from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";
import stm32Input from "../repros/fixtures/repro01-biscuit-board-stm32.srj.json";
import stm32DisplayInput from "../repros/fixtures/repro03-stm32-display-user-led.srj.json";
import boosterPackInput from "../repros/fixtures/repro06-stm32-display-boosterpack.srj.json";
import { forcedPrefabricatedViaFixture } from "../tests/fixtures/forced-prefabricated-via";

interface LadderCase {
  level: number;
  id: string;
  name: string;
  input: SimpleRouteJson;
  options: BiscuitBoardAutorouterOptions;
}

interface WorkerResult {
  level: number;
  id: string;
  name: string;
  passed: boolean;
  timedOut: boolean;
  solved: boolean;
  failed: boolean;
  error: string | null;
  elapsedMs: number;
  cpuTimeMs: number;
  stage: string;
  stageDurationsMs: Record<string, number>;
  heapUsedBeforeBytes: number;
  peakHeapUsedBytes: number;
  rssBeforeBytes: number;
  peakRssBytes: number;
  peakExternalBytes: number;
  peakArrayBuffersBytes: number;
  peakHeapGrowthBytes: number;
  peakRssGrowthBytes: number;
  retainedStageOutputCount: number;
  lowMemoryMode: boolean;
  connectionCount: number;
  obstacleCount: number;
  expectedTraceCount: number | null;
  traceCount: number;
  manufacturedViaCount: number;
  clearanceViolationCount: number;
  stats: BiscuitBoardRoutingStats | null;
}

const tinyInput: SimpleRouteJson = {
  bounds: { minX: -5, maxX: 5, minY: -3, maxY: 3 },
  layerCount: 1,
  minTraceWidth: 0.15,
  obstacles: [
    {
      type: "rect",
      width: 0.8,
      height: 0.8,
      center: { x: -3, y: 0 },
      layers: ["top"],
      connectedTo: ["left", "signal"],
    },
    {
      type: "rect",
      width: 0.8,
      height: 0.8,
      center: { x: 3, y: 0 },
      layers: ["top"],
      connectedTo: ["right", "signal"],
    },
  ],
  connections: [
    {
      name: "signal",
      pointsToConnect: [
        { x: -3, y: 0, layer: "top", pointId: "left" },
        { x: 3, y: 0, layer: "top", pointId: "right" },
      ],
    },
  ],
};

const ladderCases: LadderCase[] = [
  {
    level: 1,
    id: "tiny",
    name: "Tiny unobstructed route",
    input: tinyInput,
    options: { expandTraces: false },
  },
  {
    level: 2,
    id: "fixed-via",
    name: "Small fixed-via route",
    input: forcedPrefabricatedViaFixture,
    options: { expandTraces: false },
  },
  {
    level: 3,
    id: "stm32",
    name: "BiscuitBoard STM32C071FBP6",
    input: stm32Input as SimpleRouteJson,
    options: {},
  },
  {
    level: 4,
    id: "stm32-display",
    name: "STM32C071 display board",
    input: stm32DisplayInput as SimpleRouteJson,
    options: {},
  },
  {
    level: 5,
    id: "boosterpack",
    name: "STM32C071 display BoosterPack",
    input: boosterPackInput as SimpleRouteJson,
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
    level: 6,
    id: "rp2040",
    name: "BiscuitBoard RP2040 stress case",
    input: rp2040Input as SimpleRouteJson,
    options: {
      gridClearance: 0.1,
      maxRipsPerRoute: 1_000,
      maxTotalRips: 10_000,
    },
  },
];

const getArgument = (name: string) =>
  process.argv
    .slice(2)
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const getPositiveNumberArgument = (name: string, fallback: number) => {
  const value = Number(getArgument(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
};

const runWorker = async (
  ladderCase: LadderCase,
  maximumRuntimeMs: number,
  implementationPath: string | undefined,
  lowMemoryMode: boolean,
) => {
  const implementation = (
    implementationPath
      ? await import(pathToFileURL(resolve(implementationPath)).href)
      : await import("../lib")
  ) as typeof import("../lib");
  const { BiscuitBoardRoutingPipelineSolver, getTraceClearanceViolations } =
    implementation;
  const solver = new BiscuitBoardRoutingPipelineSolver(
    ladderCase.input,
    lowMemoryMode
      ? { ...ladderCase.options, retainIntermediateStages: false }
      : ladderCase.options,
  );
  const initialMemory = process.memoryUsage();
  let peakHeapUsedBytes = initialMemory.heapUsed;
  let peakRssBytes = initialMemory.rss;
  let peakExternalBytes = initialMemory.external;
  let peakArrayBuffersBytes = initialMemory.arrayBuffers;
  let prepared: PreparedBiscuitRoutingProblem | null = null;
  let nextMemorySampleAt = 0;
  const stageDurationsMs = new Map<string, number>();
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  let thrownError: string | null = null;

  try {
    while (
      !solver.solved &&
      !solver.failed &&
      performance.now() - startedAt < maximumRuntimeMs
    ) {
      const stage = solver.stage;
      const stepStartedAt = performance.now();
      solver.step();
      prepared ??= solver.getStageOutput<PreparedBiscuitRoutingProblem>(
        "generate-hypergraph",
      );
      const now = performance.now();
      stageDurationsMs.set(
        stage,
        (stageDurationsMs.get(stage) ?? 0) + now - stepStartedAt,
      );
      if (now >= nextMemorySampleAt) {
        const memory = process.memoryUsage();
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
        peakRssBytes = Math.max(peakRssBytes, memory.rss);
        peakExternalBytes = Math.max(peakExternalBytes, memory.external);
        peakArrayBuffersBytes = Math.max(
          peakArrayBuffersBytes,
          memory.arrayBuffers,
        );
        nextMemorySampleAt = now + 50;
      }
    }
  } catch (error) {
    thrownError = error instanceof Error ? error.message : String(error);
  }

  const elapsedMs = performance.now() - startedAt;
  const cpuUsage = process.cpuUsage(cpuStartedAt);
  const cpuTimeMs = (cpuUsage.user + cpuUsage.system) / 1_000;
  const finalMemory = process.memoryUsage();
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, finalMemory.heapUsed);
  peakRssBytes = Math.max(peakRssBytes, finalMemory.rss);
  peakExternalBytes = Math.max(peakExternalBytes, finalMemory.external);
  peakArrayBuffersBytes = Math.max(
    peakArrayBuffersBytes,
    finalMemory.arrayBuffers,
  );
  const timedOut =
    !solver.solved &&
    !solver.failed &&
    thrownError === null &&
    elapsedMs >= maximumRuntimeMs;
  const output = solver.getOutput();
  prepared ??= solver.getStageOutput<PreparedBiscuitRoutingProblem>(
    "generate-hypergraph",
  );
  const routeStats = solver.getSolver("route-with-rip-and-replace")?.stats as
    | BiscuitBoardRoutingStats
    | undefined;
  const graphStats = solver.getSolver("generate-hypergraph")?.stats as
    | BiscuitBoardRoutingStats
    | undefined;
  const clearanceViolations =
    prepared && output ? getTraceClearanceViolations(prepared, output) : [];
  const manufacturedViaCount =
    output?.traces
      .flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "via").length ?? 0;
  const expectedTraceCount = prepared?.demands.length ?? null;
  const stats = output?.stats ?? routeStats ?? graphStats ?? null;
  if (stats && graphStats) Object.assign(stats, graphStats);
  const passed = Boolean(
    solver.solved &&
      !solver.failed &&
      !thrownError &&
      output &&
      expectedTraceCount !== null &&
      output.traces.length === expectedTraceCount &&
      manufacturedViaCount === 0 &&
      clearanceViolations.length === 0,
  );

  const result: WorkerResult = {
    level: ladderCase.level,
    id: ladderCase.id,
    name: ladderCase.name,
    passed,
    timedOut,
    solved: solver.solved,
    failed: solver.failed,
    error: thrownError ?? solver.error,
    elapsedMs: Math.round(elapsedMs),
    cpuTimeMs: Math.round(cpuTimeMs),
    stage: solver.stage,
    stageDurationsMs: Object.fromEntries(
      Array.from(stageDurationsMs, ([stage, duration]) => [
        stage,
        Math.round(duration),
      ]),
    ),
    heapUsedBeforeBytes: initialMemory.heapUsed,
    peakHeapUsedBytes,
    rssBeforeBytes: initialMemory.rss,
    peakRssBytes,
    peakExternalBytes,
    peakArrayBuffersBytes,
    peakHeapGrowthBytes: Math.max(
      0,
      peakHeapUsedBytes - initialMemory.heapUsed,
    ),
    peakRssGrowthBytes: Math.max(0, peakRssBytes - initialMemory.rss),
    retainedStageOutputCount: Object.keys(
      (solver as unknown as { pipelineOutputs: Record<string, unknown> })
        .pipelineOutputs,
    ).length,
    lowMemoryMode,
    connectionCount: ladderCase.input.connections.length,
    obstacleCount: ladderCase.input.obstacles.length,
    expectedTraceCount,
    traceCount: output?.traces.length ?? 0,
    manufacturedViaCount,
    clearanceViolationCount: clearanceViolations.length,
    stats,
  };
  console.log(JSON.stringify(result));
};

const median = (values: number[]) => {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const mean = (values: number[]) =>
  values.reduce((total, value) => total + value, 0) / values.length;

const standardDeviation = (values: number[]) => {
  const average = mean(values);
  return Math.sqrt(
    mean(values.map((value) => (value - average) * (value - average))),
  );
};

const roundedMean = (values: number[]) => Math.round(mean(values));

const averageStageDurations = (runs: WorkerResult[]) => {
  const stages = new Set(
    runs.flatMap((run) => Object.keys(run.stageDurationsMs)),
  );
  return Object.fromEntries(
    Array.from(stages, (stage) => [
      stage,
      roundedMean(runs.map((run) => run.stageDurationsMs[stage] ?? 0)),
    ]),
  );
};

const percentile = (values: number[], percentileValue: number) => {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * percentileValue)]!;
};

const executeWorker = (
  ladderCase: LadderCase,
  maximumRuntimeMs: number,
  implementationPath: string | undefined,
  lowMemoryMode: boolean,
) => {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      import.meta.path,
      `--worker=${ladderCase.id}`,
      `--max-ms=${maximumRuntimeMs}`,
      ...(implementationPath ? [`--implementation=${implementationPath}`] : []),
      ...(lowMemoryMode ? ["--low-memory"] : []),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(
      `Ladder worker ${ladderCase.id} failed: ${child.stderr.toString()}`,
    );
  }
  return JSON.parse(child.stdout.toString()) as WorkerResult;
};

const summarizeRuns = (runs: WorkerResult[]) => ({
  runCount: runs.length,
  passed: runs.every(({ passed }) => passed),
  averageElapsedMs: roundedMean(runs.map(({ elapsedMs }) => elapsedMs)),
  elapsedStandardDeviationMs: Math.round(
    standardDeviation(runs.map(({ elapsedMs }) => elapsedMs)),
  ),
  medianElapsedMs: Math.round(median(runs.map(({ elapsedMs }) => elapsedMs))),
  medianCpuTimeMs: Math.round(median(runs.map(({ cpuTimeMs }) => cpuTimeMs))),
  averageCpuTimeMs: roundedMean(runs.map(({ cpuTimeMs }) => cpuTimeMs)),
  p95ElapsedMs: Math.round(
    percentile(
      runs.map(({ elapsedMs }) => elapsedMs),
      0.95,
    ),
  ),
  peakHeapUsedBytes: Math.max(
    ...runs.map(({ peakHeapUsedBytes }) => peakHeapUsedBytes),
  ),
  peakRssBytes: Math.max(...runs.map(({ peakRssBytes }) => peakRssBytes)),
  averagePeakHeapUsedBytes: roundedMean(
    runs.map(({ peakHeapUsedBytes }) => peakHeapUsedBytes),
  ),
  averagePeakRssBytes: roundedMean(
    runs.map(({ peakRssBytes }) => peakRssBytes),
  ),
  averagePeakExternalBytes: roundedMean(
    runs.map(({ peakExternalBytes }) => peakExternalBytes),
  ),
  averagePeakArrayBuffersBytes: roundedMean(
    runs.map(({ peakArrayBuffersBytes }) => peakArrayBuffersBytes),
  ),
  averagePeakHeapGrowthBytes: roundedMean(
    runs.map(({ peakHeapGrowthBytes }) => peakHeapGrowthBytes),
  ),
  averagePeakRssGrowthBytes: roundedMean(
    runs.map(({ peakRssGrowthBytes }) => peakRssGrowthBytes),
  ),
  averageStageDurationsMs: averageStageDurations(runs),
  runs,
});

const workerCaseId = getArgument("--worker");
const maximumRuntimeMs = getPositiveNumberArgument("--max-ms", 30_000);
const implementationPath = getArgument("--implementation");
const comparisonImplementationPath = getArgument("--compare");
const lowMemoryMode = process.argv.includes("--low-memory");
if (workerCaseId) {
  const ladderCase = ladderCases.find(({ id }) => id === workerCaseId);
  if (!ladderCase) throw new Error(`Unknown ladder case: ${workerCaseId}`);
  await runWorker(
    ladderCase,
    maximumRuntimeMs,
    implementationPath,
    lowMemoryMode,
  );
} else {
  const requestedCaseIds = process.argv
    .filter((argument) => argument.startsWith("--case="))
    .map((argument) => argument.slice("--case=".length));
  const selectedCases =
    requestedCaseIds.length === 0
      ? ladderCases
      : ladderCases.filter(({ id }) => requestedCaseIds.includes(id));
  if (selectedCases.length === 0) {
    throw new Error(
      `No matching ladder cases. Available: ${ladderCases.map(({ id }) => id).join(", ")}`,
    );
  }
  const runCount = getPositiveNumberArgument("--runs", 1);
  const results = selectedCases.map((ladderCase) => {
    if (!comparisonImplementationPath) {
      return {
        level: ladderCase.level,
        id: ladderCase.id,
        name: ladderCase.name,
        ...summarizeRuns(
          Array.from({ length: runCount }, () =>
            executeWorker(
              ladderCase,
              maximumRuntimeMs,
              implementationPath,
              lowMemoryMode,
            ),
          ),
        ),
      };
    }
    const previousRuns: WorkerResult[] = [];
    const currentRuns: WorkerResult[] = [];
    for (let runIndex = 0; runIndex < runCount; runIndex++) {
      const order =
        runIndex % 2 === 0
          ? (["previous", "current"] as const)
          : (["current", "previous"] as const);
      for (const version of order) {
        const result = executeWorker(
          ladderCase,
          maximumRuntimeMs,
          version === "previous"
            ? comparisonImplementationPath
            : implementationPath,
          lowMemoryMode,
        );
        (version === "previous" ? previousRuns : currentRuns).push(result);
      }
    }
    const previous = summarizeRuns(previousRuns);
    const current = summarizeRuns(currentRuns);
    return {
      level: ladderCase.level,
      id: ladderCase.id,
      name: ladderCase.name,
      runCount,
      passed: previous.passed && current.passed,
      previous,
      current,
    };
  });
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        maximumRuntimeMs,
        passed: results.every(({ passed }) => passed),
        results,
      },
      null,
      2,
    ),
  );
}

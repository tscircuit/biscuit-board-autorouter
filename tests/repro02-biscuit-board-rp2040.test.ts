import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { measureTraceWidths } from "@tscircuit/power-trace-expander";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  BeautifyBiscuitBoardTracesSolver,
  generateBiscuitBoardHypergraph,
  getTraceClearanceViolations,
  ExpandBiscuitBoardTracesSolver,
  fitExpandedTraceWidthsToClearance,
  PostProcessBiscuitBoardTracesSolver,
  type BiscuitBoardRoutingSolution,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import builtFixture from "../repros/fixtures/repro02-biscuit-board-rp2040.built.json";
import capturedInput from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";
import solvedFixture from "../repros/fixtures/repro02-biscuit-board-rp2040.solved.json";

const input = capturedInput as SimpleRouteJson;
const built = builtFixture as BiscuitBoardRoutingSolution;
const solved = solvedFixture as BiscuitBoardRoutingSolution;
const pointIsOnTrace = (
  point: { x: number; y: number; layer: string },
  trace: BiscuitBoardRoutingSolution["traces"][number],
) => {
  if (
    trace.route.some(
      (routePoint) =>
        routePoint.route_type === "wire" &&
        routePoint.layer === point.layer &&
        Math.abs(routePoint.x - point.x) <= 1e-6 &&
        Math.abs(routePoint.y - point.y) <= 1e-6,
    )
  ) {
    return true;
  }
  for (let index = 1; index < trace.route.length; index++) {
    const start = trace.route[index - 1]!;
    const end = trace.route[index]!;
    if (
      start.route_type !== "wire" ||
      end.route_type !== "wire" ||
      start.layer !== point.layer ||
      end.layer !== point.layer
    ) {
      continue;
    }
    const cross =
      (point.x - start.x) * (end.y - start.y) -
      (point.y - start.y) * (end.x - start.x);
    const dot =
      (point.x - start.x) * (point.x - end.x) +
      (point.y - start.y) * (point.y - end.y);
    if (Math.abs(cross) <= 1e-6 && dot <= 1e-6) return true;
  }
  return false;
};
let prepared: PreparedBiscuitRoutingProblem | undefined;
const getPrepared = () =>
  (prepared ??= generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.1,
    maxRipsPerRoute: 1_000,
    maxTotalRips: 10_000,
    routeOrder: "signal_longest_first",
  }));
let beautifier: BeautifyBiscuitBoardTracesSolver | undefined;
const getBeautifier = () => {
  if (beautifier) return beautifier;
  beautifier = new BeautifyBiscuitBoardTracesSolver({
    prepared: getPrepared(),
    built: solved,
  });
  beautifier.solve();
  return beautifier;
};

test("preserves the exact BiscuitBoard RP2040 routing reproduction", () => {
  expect(input.connections).toHaveLength(35);
  expect(input.obstacles).toHaveLength(215);
  expect(
    input.obstacles.filter(
      (obstacle) =>
        obstacle.netIsAssignable &&
        obstacle.connectedTo.some((id) => id.startsWith("pcb_via")),
    ),
  ).toHaveLength(54);

  const problem = getPrepared();
  expect(problem.demands).toHaveLength(97);
  expect(problem.prefabricatedVias).toHaveLength(54);
  expect(problem.nodes.length).toBeGreaterThan(50_000);
  expect(problem.edges.length).toBeGreaterThan(100_000);
  expect(
    problem.edges.filter((edge) => edge.kind === "fixed_via_transition"),
  ).toHaveLength(54);
}, 30_000);

test("beautifies the solved BiscuitBoard RP2040 repro02 SVG", async () => {
  const problem = getPrepared();
  const solver = new PostProcessBiscuitBoardTracesSolver({
    prepared: problem,
    built,
  });
  solver.solve();
  const output = solver.getOutput();

  expect(output).toEqual(solved);
  expect(output?.routes).toHaveLength(97);
  expect(output?.traces).toHaveLength(97);
  expect(
    output?.traces.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    ),
  ).toEqual([]);
  expect(getTraceClearanceViolations(problem, output!)).toEqual([]);
  const protectedTreeJunctions = output!.routes.flatMap((route, traceIndex) => {
    const demand = problem.demandById.get(route.routeId)!;
    return [route.nodePath[0], route.nodePath.at(-1)].flatMap((endpointNode) =>
      endpointNode !== undefined &&
      endpointNode !== demand.sourceNode &&
      endpointNode !== demand.targetNode
        ? [
            {
              traceIndex,
              netId: route.netId,
              node: problem.nodes[endpointNode]!,
            },
          ]
        : [],
    );
  });
  expect(protectedTreeJunctions.length).toBeGreaterThan(0);
  expect(
    protectedTreeJunctions.every(({ traceIndex, netId, node }) =>
      output!.traces.some(
        (trace, otherTraceIndex) =>
          otherTraceIndex !== traceIndex &&
          output!.routes[otherTraceIndex]!.netId === netId &&
          pointIsOnTrace(node, trace),
      ),
    ),
  ).toBe(true);

  const beautifier = getBeautifier();
  expect(beautifier.failed).toBe(false);
  const beautified = beautifier.getOutput()!;
  expect(beautified.traces).not.toEqual(output!.traces);
  expect(beautified.stats.sameNetConsolidationCount).toBeGreaterThan(0);
  expect(beautified.stats.fortyFiveDegreeChamferCount).toBeGreaterThan(0);
  expect(getTraceClearanceViolations(problem, beautified)).toEqual([]);

  const beautificationGraphics = beautifier.visualize();
  expect(beautificationGraphics.rects?.length).toBeGreaterThan(0);
  expect(beautificationGraphics.circles?.length).toBeGreaterThan(0);
  const obstacleLabels = [
    ...(beautificationGraphics.rects ?? []),
    ...(beautificationGraphics.circles ?? []),
  ].map((shape) => shape.label ?? "");
  expect(obstacleLabels.some((label) => label.startsWith("obstacle ·"))).toBe(
    true,
  );
  expect(
    obstacleLabels.some((label) => label.includes("prefabricated via")),
  ).toBe(true);
  const svg = getSvgFromGraphicsObject(beautificationGraphics, {
    backgroundColor: "white",
    svgWidth: 1200,
    svgHeight: 900,
  });

  await expect(svg).toMatchSvgSnapshot(import.meta.path);
}, 60_000);

test("expands the RP2040 repro toward a 0.3mm nominal width", () => {
  const baseProblem = getPrepared();
  const targetInput = {
    ...baseProblem.input,
    nominalTraceWidth: 0.3,
    connections: baseProblem.input.connections.map((connection) => ({
      ...connection,
      nominalTraceWidth: 0.3,
    })),
  };
  const problem = { ...baseProblem, input: targetInput };
  const before = measureTraceWidths(targetInput, solved.traces).get(0.3)!;
  const solver = new ExpandBiscuitBoardTracesSolver({
    prepared: problem,
    built: solved,
  });

  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  const output = solver.getOutput()!;
  const after = measureTraceWidths(targetInput, output.traces).get(0.3)!;
  expect(before.nominalCoverage).toBe(0);
  expect(after.nominalCoverage).toBeGreaterThan(0.8);
  expect(after.normalizedWidthDeficit).toBeLessThan(0.1);
  expect(after.averageWidth).toBeGreaterThan(0.27);
  expect(
    output.traces.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    ),
  ).toEqual([]);
  expect(
    output.traces.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "through_obstacle"),
    ),
  ).toHaveLength(44);

  const baselineTrace = solved.traces.find(
    (trace) => trace.pcb_trace_id === "pcb_trace_source_net_4_17",
  )!;
  const shallowPadTrace = {
    ...baselineTrace,
    route: [
      [11, 8.16, 0.3],
      [10.35, 7.5, 0.3],
      [10.48, 6.45, 0.3],
      [10.48, 5.26, 0.3],
      [11.02, 5.26, 0.3],
      [10.7305, 5.26, 0.3],
      [10.7625, 5.25, 0.3],
      [9.283, 5.26, 0.2625],
      [8.125, 5.26, 0.3],
      [8.125, 5.75, 0.3],
    ].map(([x, y, width]) => ({
      route_type: "wire" as const,
      x,
      y,
      width,
      layer: "top",
    })),
  };
  const fittedPadTrace = fitExpandedTraceWidthsToClearance(
    problem,
    [shallowPadTrace],
    [baselineTrace],
  )[0]!;
  expect(fittedPadTrace.route[6]?.route_type).toBe("wire");
  expect(
    fittedPadTrace.route[6]?.route_type === "wire"
      ? fittedPadTrace.route[6].width
      : 0.3,
  ).toBeLessThan(0.3);
}, 60_000);

import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  generateBiscuitBoardHypergraph,
  getTraceClearanceViolations,
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

test("matches the solved BiscuitBoard RP2040 repro02 SVG", async () => {
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

  const svg = getSvgFromGraphicsObject(solver.visualize(), {
    backgroundColor: "white",
    svgWidth: 1200,
    svgHeight: 900,
  });

  await expect(svg).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

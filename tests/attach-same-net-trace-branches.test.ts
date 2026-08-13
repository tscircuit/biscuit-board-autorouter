import { expect, test } from "bun:test";
import type { SimplifiedPcbTrace } from "@tscircuit/core";
import { attachSameNetTraceBranches } from "../lib/build-biscuit-board-traces-solver";
import type {
  BiscuitBoardRoutingSolution,
  RoutedConnection,
} from "../lib/types";

type WirePoint = Extract<
  SimplifiedPcbTrace["route"][number],
  { route_type: "wire" }
>;

const wire = (x: number, y: number): WirePoint => ({
  route_type: "wire",
  x,
  y,
  width: 0.2,
  layer: "top",
});

const route = (routeId: string, netId: string): RoutedConnection => ({
  routeId,
  connectionName: netId,
  netId,
  nodePath: [],
  edgePath: [],
  blockerRouteIds: [],
});

const trace = (
  traceId: string,
  points: Array<[number, number]>,
): SimplifiedPcbTrace => ({
  type: "pcb_trace",
  pcb_trace_id: traceId,
  connection_name: "gnd",
  connectsTo: [],
  route: points.map(([x, y]) => wire(x, y)),
});

const makeSolution = (
  routes: RoutedConnection[],
  traces: SimplifiedPcbTrace[],
  fixedViaTransitionCount = 0,
): BiscuitBoardRoutingSolution => ({
  routes,
  traces,
  stats: {
    routeCount: routes.length,
    routedCount: routes.length,
    pendingCount: 0,
    ripCount: 0,
    expandedStateCount: 0,
    fixedViaTransitionCount,
    graphNodeCount: 0,
    graphEdgeCount: 0,
  },
});

test("adds an unconnected branch only as far as existing same-net copper", () => {
  const solution = makeSolution(
    [route("connection", "gnd"), route("tree", "gnd"), route("branch", "gnd")],
    [
      trace("connection", [
        [0, 0],
        [1, 0],
      ]),
      trace("tree", [
        [1, 0],
        [4, 0],
      ]),
      trace("branch", [
        [0, 0],
        [2, 2],
        [2, -2],
      ]),
    ],
  );

  const output = attachSameNetTraceBranches(solution);

  expect(output.stats.sameNetTreeAttachmentCount).toBe(1);
  expect(output.traces[1]!.route).toEqual([wire(1, 0), wire(2, 0), wire(4, 0)]);
  expect(output.traces[2]!.route).toEqual([wire(2, 0), wire(2, -2)]);
  expect(solution.traces[1]!.route).toEqual([wire(1, 0), wire(4, 0)]);
});

test("does not attach branches to copper from another net", () => {
  const solution = makeSolution(
    [route("tree", "gnd"), route("branch", "power")],
    [
      trace("tree", [
        [0, 0],
        [4, 0],
      ]),
      trace("branch", [
        [0, 0],
        [2, 2],
        [2, -2],
      ]),
    ],
  );

  const output = attachSameNetTraceBranches(solution);

  expect(output.stats.sameNetTreeAttachmentCount).toBeUndefined();
  expect(output.traces).toEqual(solution.traces);
});

test("does not move an endpoint already attached to the crossing trace", () => {
  const solution = makeSolution(
    [route("tree", "gnd"), route("branch", "gnd")],
    [
      trace("tree", [
        [2, 0],
        [0, 2],
        [2, 2],
      ]),
      trace("branch", [
        [0, 0],
        [2, 2],
      ]),
    ],
  );

  const output = attachSameNetTraceBranches(solution);

  expect(output.stats.sameNetTreeAttachmentCount).toBeUndefined();
  expect(output.traces).toEqual(solution.traces);
});

test("does not add a crossing junction between routes sharing a terminal", () => {
  const anchor = trace("tree", [
    [1, 0],
    [4, 0],
  ]);
  const branch = trace("branch", [
    [0, 0],
    [2, 2],
    [2, -2],
  ]);
  anchor.connectsTo = ["shared-terminal"];
  branch.connectsTo = ["shared-terminal"];
  const solution = makeSolution(
    [route("connection", "gnd"), route("tree", "gnd"), route("branch", "gnd")],
    [
      trace("connection", [
        [0, 0],
        [1, 0],
      ]),
      anchor,
      branch,
    ],
  );

  const output = attachSameNetTraceBranches(solution);

  expect(output.stats.sameNetTreeAttachmentCount).toBeUndefined();
  expect(output.traces).toEqual(solution.traces);
});

test("does not discard an assigned layer transition when attaching", () => {
  const branch = trace("branch", [
    [2, -2],
    [2, 2],
  ]);
  branch.route.push(
    {
      route_type: "through_obstacle",
      start: { x: 3, y: 2 },
      end: { x: 3, y: 2 },
      from_layer: "top",
      to_layer: "bottom",
      width: 0.2,
    },
    { ...wire(3, 2), layer: "bottom" },
    {
      route_type: "through_obstacle",
      start: { x: 4, y: 0 },
      end: { x: 4, y: 0 },
      from_layer: "bottom",
      to_layer: "top",
      width: 0.2,
    },
    wire(4, 0),
  );
  const solution = makeSolution(
    [route("tree", "gnd"), route("branch", "gnd")],
    [
      trace("tree", [
        [0, 0],
        [4, 0],
      ]),
      branch,
    ],
    2,
  );

  const output = attachSameNetTraceBranches(solution);

  expect(output.stats.sameNetTreeAttachmentCount).toBeUndefined();
  expect(output.traces).toEqual(solution.traces);
});

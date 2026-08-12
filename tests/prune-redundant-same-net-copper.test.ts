import { expect, test } from "bun:test";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import {
  generateBiscuitBoardHypergraph,
  pruneRedundantSameNetCopper,
  type BiscuitBoardRoutingSolution,
} from "../lib";

const createCycleProblem = (
  widths = [0.15, 0.15, 0.15],
  obstacles: SimpleRouteJson["obstacles"] = [],
) => {
  const input: SimpleRouteJson = {
    bounds: { minX: -1, minY: -1, maxX: 5, maxY: 3 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles,
    connections: [
      {
        name: "a-to-b",
        width: widths[0],
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pointId: "a" },
          { x: 2, y: 2, layer: "top", pointId: "b" },
        ],
      },
      {
        name: "b-to-c",
        width: widths[1],
        pointsToConnect: [
          { x: 2, y: 2, layer: "top", pointId: "b" },
          { x: 4, y: 0, layer: "top", pointId: "c" },
        ],
      },
      {
        name: "a-to-c",
        width: widths[2],
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pointId: "a" },
          { x: 4, y: 0, layer: "top", pointId: "c" },
        ],
      },
    ],
  };
  const prepared = generateBiscuitBoardHypergraph(input);
  const routes = [
    [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ],
    [
      { x: 2, y: 2 },
      { x: 4, y: 0 },
    ],
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ],
  ];
  const traces: SimplifiedPcbTrace[] = prepared.demands.map(
    (demand, index) => ({
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_${index}`,
      connection_name: demand.connectionName,
      connectsTo: [demand.sourcePointId!, demand.targetPointId!],
      route: routes[index]!.map((point) => ({
        route_type: "wire" as const,
        ...point,
        width: demand.width,
        layer: "top",
      })),
    }),
  );
  const solution: BiscuitBoardRoutingSolution = {
    routes: prepared.demands.map((demand) => ({
      routeId: demand.routeId,
      connectionName: demand.connectionName,
      netId: demand.netId,
      nodePath: [demand.sourceNode, demand.targetNode],
      edgePath: [],
      blockerRouteIds: [],
    })),
    traces,
    stats: {
      routeCount: traces.length,
      routedCount: traces.length,
      pendingCount: 0,
      ripCount: 0,
      expandedStateCount: 0,
      fixedViaTransitionCount: 0,
      graphNodeCount: prepared.nodes.length,
      graphEdgeCount: prepared.edges.length,
    },
  };
  return { prepared, solution, traces };
};

test("removes a same-net cycle while preserving every trace attachment", () => {
  const { prepared, solution, traces } = createCycleProblem();

  const pruned = pruneRedundantSameNetCopper(prepared, solution);

  expect(pruned.stats.sameNetCyclePruneCount).toBe(1);
  expect(pruned.stats.prunedSameNetEdgeCount).toBe(1);
  expect(pruned.traces[0]!.route).toEqual(traces[0]!.route);
  expect(pruned.traces[1]!.route).toEqual(traces[1]!.route);
  expect(pruned.traces[2]!.route).toEqual([
    expect.objectContaining({ x: 0, y: 0, layer: "top" }),
    expect.objectContaining({ x: 2, y: 2, layer: "top" }),
    expect.objectContaining({ x: 4, y: 0, layer: "top" }),
  ]);
  expect(pruned.traces.map((trace) => trace.connectsTo)).toEqual([
    ["a", "b"],
    ["b", "c"],
    ["a", "c"],
  ]);
});

test("keeps the original cycle when a wider replacement would violate clearance", () => {
  const { prepared, solution } = createCycleProblem(
    [0.1, 0.1, 0.5],
    [
      {
        type: "rect",
        center: { x: 1, y: 1.5 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: ["foreign-pad"],
      },
    ],
  );

  const pruned = pruneRedundantSameNetCopper(prepared, solution);

  expect(pruned.stats.sameNetCyclePruneCount).toBe(0);
  expect(pruned.stats.sameNetCyclePruneSkipCount).toBe(1);
  expect(pruned.stats.prunedSameNetEdgeCount).toBe(0);
  expect(pruned.traces).toEqual(solution.traces);
});

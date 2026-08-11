import { expect, test } from "bun:test";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import {
  beautifyBiscuitBoardTraces,
  type BiscuitBoardRoutingSolution,
  generateBiscuitBoardHypergraph,
  getTraceClearanceViolations,
} from "../lib";

const createSolution = (
  input: SimpleRouteJson,
  routes: Array<Array<{ x: number; y: number }>>,
) => {
  const prepared = generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.2,
  });
  const traces: SimplifiedPcbTrace[] = prepared.demands.map(
    (demand, traceIndex) => ({
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_${traceIndex}`,
      connection_name: demand.connectionName,
      connectsTo: [demand.sourcePointId, demand.targetPointId].filter(
        (pointId): pointId is string => Boolean(pointId),
      ),
      route: routes[traceIndex]!.map((point) => ({
        route_type: "wire" as const,
        ...point,
        layer: "top",
        width: demand.width,
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
  return { prepared, solution };
};

test("beautification takes the largest available 45-degree corner", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles: [],
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: 1, y: 1, layer: "top", pointId: "start" },
          { x: 5, y: 5, layer: "top", pointId: "end" },
        ],
      },
    ],
  };
  const { prepared, solution } = createSolution(input, [
    [
      { x: 1, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 5 },
    ],
  ]);

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);
  const wirePoints = beautified.traces[0]!.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(wirePoints).toHaveLength(2);
  expect(Math.abs(wirePoints[1]!.x - wirePoints[0]!.x)).toBe(
    Math.abs(wirePoints[1]!.y - wirePoints[0]!.y),
  );
  expect(beautified.stats.fortyFiveDegreeChamferCount).toBe(1);
});

test("beautification increases spacing between foreign-net traces", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.2,
    obstacles: [],
    connections: [
      {
        name: "wide-span",
        width: 0.1,
        pointsToConnect: [
          { x: 1, y: 4, layer: "top", pointId: "a-left" },
          { x: 9, y: 4, layer: "top", pointId: "a-right" },
        ],
      },
      {
        name: "short-span",
        width: 0.1,
        pointsToConnect: [
          { x: 2, y: 4.35, layer: "top", pointId: "b-left" },
          { x: 8, y: 4.35, layer: "top", pointId: "b-right" },
        ],
      },
    ],
  };
  const { prepared, solution } = createSolution(input, [
    [
      { x: 1, y: 4 },
      { x: 9, y: 4 },
    ],
    [
      { x: 2, y: 4.35 },
      { x: 8, y: 4.35 },
    ],
  ]);
  expect(getTraceClearanceViolations(prepared, solution, 0.2)).toEqual([]);
  expect(getTraceClearanceViolations(prepared, solution, 0.4)).not.toEqual([]);

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);
  expect(beautified.stats.beautifiedClearance).toBeGreaterThan(0.2);
  expect(
    getTraceClearanceViolations(
      prepared,
      beautified,
      beautified.stats.beautifiedClearance,
    ),
  ).toEqual([]);
});

test("beautification consolidates same-net spans onto shared copper", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.1,
    obstacles: [
      {
        type: "rect",
        center: { x: 5, y: 5 },
        width: 2,
        height: 2,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    connections: [
      {
        name: "upper-branch",
        width: 0.1,
        pointsToConnect: [
          { x: 1, y: 5, layer: "top", pointId: "shared-left" },
          { x: 9, y: 5, layer: "top", pointId: "shared-right" },
        ],
      },
      {
        name: "lower-branch",
        width: 0.1,
        pointsToConnect: [
          { x: 1, y: 5, layer: "top", pointId: "shared-left" },
          { x: 9, y: 5, layer: "top", pointId: "shared-right" },
        ],
      },
    ],
  };
  const { prepared, solution } = createSolution(input, [
    [
      { x: 1, y: 5 },
      { x: 3, y: 6.7 },
      { x: 7, y: 6.7 },
      { x: 9, y: 5 },
    ],
    [
      { x: 1, y: 5 },
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 9, y: 5 },
    ],
  ]);

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);
  const geometry = beautified.traces.map((trace) =>
    trace.route.map((point) =>
      point.route_type === "wire" ? [point.x, point.y] : point.route_type,
    ),
  );
  expect(geometry[1]).toEqual(geometry[0]);
  expect(beautified.stats.sameNetConsolidationCount).toBeGreaterThan(0);
});

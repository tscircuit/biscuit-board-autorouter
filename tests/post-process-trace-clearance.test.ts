import { expect, test } from "bun:test";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import {
  type BiscuitBoardRoutingSolution,
  generateBiscuitBoardHypergraph,
  getTraceClearanceViolations,
  postProcessBiscuitBoardTraces,
} from "../lib";

test("post-processing detours traces that enter cleanup below clearance", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    obstacles: [],
    connections: [
      {
        name: "horizontal",
        width: 0.15,
        pointsToConnect: [
          { x: 1, y: 5, layer: "top", pointId: "left" },
          { x: 9, y: 5, layer: "top", pointId: "right" },
        ],
      },
      {
        name: "vertical",
        width: 0.15,
        pointsToConnect: [
          { x: 5, y: 4, layer: "top", pointId: "bottom" },
          { x: 5, y: 6, layer: "top", pointId: "top" },
        ],
      },
    ],
  };
  const prepared = generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.1,
  });
  const traces: SimplifiedPcbTrace[] = input.connections.map((connection) => ({
    type: "pcb_trace",
    pcb_trace_id: `pcb_trace_${connection.name}`,
    connection_name: connection.name,
    connectsTo: connection.pointsToConnect.flatMap((point) =>
      point.pointId ? [point.pointId] : [],
    ),
    route: connection.pointsToConnect.map((point) => ({
      route_type: "wire",
      x: point.x,
      y: point.y,
      layer: point.layer,
      width: connection.width ?? input.minTraceWidth,
    })),
  }));
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
      routeCount: 2,
      routedCount: 2,
      pendingCount: 0,
      ripCount: 0,
      expandedStateCount: 0,
      fixedViaTransitionCount: 0,
      graphNodeCount: prepared.nodes.length,
      graphEdgeCount: prepared.edges.length,
    },
  };

  expect(getTraceClearanceViolations(prepared, solution)).not.toEqual([]);
  const repaired = postProcessBiscuitBoardTraces(prepared, solution);
  expect(getTraceClearanceViolations(prepared, repaired)).toEqual([]);
  expect(repaired.traces.some((trace) => trace.route.length > 2)).toBe(true);
});

test("post-processing widens a rotated-obstacle detour when nearby traces block it", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.2,
    minTraceToPadEdgeClearance: 0.1,
    obstacles: [
      {
        type: "rect",
        center: { x: 5, y: 5 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: [],
        ccwRotationDegrees: 45,
      },
    ],
    connections: [
      {
        name: "main",
        width: 0.2,
        pointsToConnect: [
          { x: 1, y: 5.75, layer: "top", pointId: "main-left" },
          { x: 9, y: 5.75, layer: "top", pointId: "main-right" },
        ],
      },
      {
        name: "lower-blocker",
        width: 0.2,
        pointsToConnect: [
          { x: 2, y: 4, layer: "top", pointId: "lower-left" },
          { x: 8, y: 4, layer: "top", pointId: "lower-right" },
        ],
      },
      {
        name: "upper-blocker",
        width: 0.2,
        pointsToConnect: [
          { x: 2, y: 6.2, layer: "top", pointId: "upper-left" },
          { x: 8, y: 6.2, layer: "top", pointId: "upper-right" },
        ],
      },
    ],
  };
  const prepared = generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.1,
  });
  const traces: SimplifiedPcbTrace[] = input.connections.map((connection) => ({
    type: "pcb_trace",
    pcb_trace_id: `pcb_trace_${connection.name}`,
    connection_name: connection.name,
    connectsTo: connection.pointsToConnect.flatMap((point) =>
      point.pointId ? [point.pointId] : [],
    ),
    route: connection.pointsToConnect.map((point) => ({
      route_type: "wire",
      x: point.x,
      y: point.y,
      layer: point.layer,
      width: connection.width ?? input.minTraceWidth,
    })),
  }));
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

  const repaired = postProcessBiscuitBoardTraces(prepared, solution);
  expect(getTraceClearanceViolations(prepared, repaired)).toEqual([]);
  const mainTrace = repaired.traces.find(
    (trace) => trace.connection_name === "main",
  );
  expect(mainTrace).toBeDefined();
  expect(mainTrace?.route.length).toBeGreaterThan(2);
  const detourYs =
    mainTrace?.route.flatMap((point) =>
      point.route_type === "wire" ? [point.y] : [],
    ) ?? [];
  expect(Math.min(...detourYs) < 3.8 || Math.max(...detourYs) > 6.3).toBe(true);
});

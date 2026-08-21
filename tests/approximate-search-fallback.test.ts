import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import {
  generateBiscuitBoardHypergraph,
  RipUpRubberBandSolver,
  type RouteDemand,
  type RoutingEdge,
  type RoutingNode,
} from "../lib";

test("falls back to exact A* when the bounded corridor misses", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: -2, minY: -7, maxX: 12, maxY: 7 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles: [],
    connections: [],
  };
  const prepared = generateBiscuitBoardHypergraph(input, {
    approximateSearchMinDemandCount: 1,
    beamWidth: 1,
    coarseCorridorStretch: 1.5,
  });
  const makeNode = (nodeId: string, x: number, y: number): RoutingNode => ({
    nodeId,
    x,
    y,
    layer: "top",
    kind: "grid",
    terminalPointIds: [],
    terminalConnectionNames: [],
  });
  prepared.nodes = [
    makeNode("source", 0, 0),
    makeNode("trap", 9, 0),
    makeNode("good", 0, 5),
    makeNode("decoy", 0, -5),
    makeNode("target", 10, 0),
  ];
  prepared.edges = [];
  prepared.conflictOffsets = undefined;
  prepared.compactConflictEdgeIds = undefined;
  prepared.adjacency = Array.from({ length: prepared.nodes.length }, () => []);
  const addEdge = (fromNode: number, toNode: number) => {
    const edgeId = prepared.edges.length;
    const from = prepared.nodes[fromNode]!;
    const to = prepared.nodes[toNode]!;
    const edge: RoutingEdge = {
      edgeId,
      key: `trace:${fromNode}:${toNode}`,
      kind: "trace",
      fromNode,
      toNode,
      cost: Math.hypot(to.x - from.x, to.y - from.y),
      blockingObstacleIndexes: [],
      conflictEdgeIds: [],
    };
    prepared.edges.push(edge);
    prepared.adjacency[fromNode]!.push({ edgeId, toNode });
    prepared.adjacency[toNode]!.push({ edgeId, toNode: fromNode });
  };
  addEdge(0, 1);
  addEdge(0, 2);
  addEdge(0, 3);
  addEdge(2, 4);

  const demand: RouteDemand = {
    routeId: "corridor-fallback",
    connectionName: "corridor-fallback",
    connectionTerminalCount: 2,
    netId: "corridor-fallback",
    sourceNode: 0,
    targetNode: 4,
    width: 0.15,
  };
  prepared.demands = [demand];
  prepared.demandById = new Map([[demand.routeId, demand]]);

  const solver = new RipUpRubberBandSolver(prepared);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  expect(solver.getOutput().routes[0]?.nodePath).toEqual([0, 2, 4]);
  expect(solver.getOutput().stats.approximateSearchCount).toBe(2);
  expect(solver.getOutput().stats.approximateFallbackCount).toBe(1);
});

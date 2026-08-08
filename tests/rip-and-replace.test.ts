import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import {
  generateBiscuitBoardHypergraph,
  RipUpRubberBandSolver,
  type RouteDemand,
  type RoutingEdge,
  type RoutingNode,
} from "../lib";

test("rips a chokepoint route and requeues it onto a clear corridor", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: -6, minY: -2, maxX: 6, maxY: 4 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles: [],
    connections: [],
  };
  const prepared = generateBiscuitBoardHypergraph(input, {
    ripCost: 0.1,
    historyIncrement: 10,
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
    makeNode("a-start", -5, 0),
    makeNode("choke", 0, 0),
    makeNode("a-end", 5, 0),
    makeNode("a-alt-left", -5, 3),
    makeNode("a-alt-right", 5, 3),
    makeNode("b-start", 0, -1),
    makeNode("b-end", 0, 1),
  ];
  prepared.edges = [];
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
  addEdge(1, 2);
  addEdge(0, 3);
  addEdge(3, 4);
  addEdge(4, 2);
  addEdge(5, 1);
  addEdge(1, 6);

  const demands: RouteDemand[] = [
    {
      routeId: "a-flexible",
      connectionName: "a-flexible",
      netId: "a-flexible",
      sourceNode: 0,
      targetNode: 2,
      width: 0.15,
    },
    {
      routeId: "b-chokepoint",
      connectionName: "b-chokepoint",
      netId: "b-chokepoint",
      sourceNode: 5,
      targetNode: 6,
      width: 0.15,
    },
  ];
  prepared.demands = demands;
  prepared.demandById = new Map(
    demands.map((demand) => [demand.routeId, demand]),
  );

  const solver = new RipUpRubberBandSolver(prepared);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  expect(solver.getOutput().stats.ripCount).toBeGreaterThan(0);
  expect(solver.getOutput().routes).toHaveLength(2);
  expect(solver.committedRoutes.get("a-flexible")!.nodePath).toEqual([
    0, 3, 4, 2,
  ]);
});

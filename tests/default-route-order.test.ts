import { expect, test } from "bun:test";
import {
  DEFAULT_ROUTE_ORDER,
  generateBiscuitBoardHypergraph,
  RipUpRubberBandSolver,
  type RouteDemand,
  type RoutingEdge,
  type RoutingNode,
} from "../lib";

test("uses one adaptive default for every routing topology", () => {
  expect(DEFAULT_ROUTE_ORDER).toBe("adaptive");
});

test("adaptive priority responds to live endpoint constraints", () => {
  const prepared = generateBiscuitBoardHypergraph({
    bounds: { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles: [],
    connections: [],
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
    makeNode("wide-source", 0, 0),
    makeNode("wide-target", 10, 0),
    makeNode("constrained-source", 0, 1),
    makeNode("constrained-target", 1, 1),
    ...Array.from({ length: 12 }, (_, index) =>
      makeNode(`escape-${index}`, index % 6, index < 6 ? -1 : 1),
    ),
  ];
  prepared.edges = [];
  prepared.adjacency = Array.from({ length: prepared.nodes.length }, () => []);
  const addEdge = (fromNode: number, toNode: number) => {
    const edgeId = prepared.edges.length;
    const edge: RoutingEdge = {
      edgeId,
      key: `edge-${edgeId}`,
      kind: "trace",
      fromNode,
      toNode,
      cost: 1,
      blockingObstacleIndexes: [],
      conflictEdgeIds: [],
    };
    prepared.edges.push(edge);
    prepared.adjacency[fromNode]!.push({ edgeId, toNode });
    prepared.adjacency[toNode]!.push({ edgeId, toNode: fromNode });
  };
  for (let index = 0; index < 6; index++) addEdge(0, 4 + index);
  for (let index = 0; index < 6; index++) addEdge(1, 10 + index);
  addEdge(2, 3);

  const demands: RouteDemand[] = [
    {
      routeId: "wide",
      connectionName: "wide",
      connectionTerminalCount: 2,
      netId: "wide",
      sourceNode: 0,
      targetNode: 1,
      width: 0.15,
    },
    {
      routeId: "constrained",
      connectionName: "constrained",
      connectionTerminalCount: 2,
      netId: "constrained",
      sourceNode: 2,
      targetNode: 3,
      width: 0.15,
    },
  ];
  prepared.demands = demands;
  prepared.demandById = new Map(
    demands.map((demand) => [demand.routeId, demand]),
  );

  const solver = new RipUpRubberBandSolver(prepared);
  solver._step();

  expect(solver.committedRoutes.has("constrained")).toBe(true);
  expect(solver.committedRoutes.has("wide")).toBe(false);
  expect(solver.getOutput().stats.adaptivePriorityChangeCount).toBe(1);
});

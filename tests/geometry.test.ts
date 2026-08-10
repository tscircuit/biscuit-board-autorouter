import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { generateBiscuitBoardHypergraph, RipUpRubberBandSolver } from "../lib";
import { obstacleBounds } from "../lib/geometry";

test("obstacle bounds include rotation and clearance", () => {
  const bounds = obstacleBounds(
    {
      center: { x: 10, y: -5 },
      width: 1.2,
      height: 1.8,
      ccwRotationDegrees: 270,
    },
    0.15,
  );

  expect(bounds.minX).toBeCloseTo(8.95);
  expect(bounds.maxX).toBeCloseTo(11.05);
  expect(bounds.minY).toBeCloseTo(-5.75);
  expect(bounds.maxY).toBeCloseTo(-4.25);
});

test("obstacle bounds can preserve the routing graph's unrotated envelope", () => {
  const bounds = obstacleBounds(
    {
      center: { x: 10, y: -5 },
      width: 1.2,
      height: 1.8,
      ccwRotationDegrees: 270,
    },
    0.15,
    false,
  );

  expect(bounds.minX).toBeCloseTo(9.25);
  expect(bounds.maxX).toBeCloseTo(10.75);
  expect(bounds.minY).toBeCloseTo(-6.05);
  expect(bounds.maxY).toBeCloseTo(-3.95);
});

test("graph generation can reserve rotated obstacle envelopes", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    connections: [],
    obstacles: [
      {
        type: "rect",
        center: { x: 1, y: 5 },
        width: 1.2,
        height: 1.8,
        ccwRotationDegrees: 270,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  };
  const withoutRotation = generateBiscuitBoardHypergraph(input, {
    gridPitch: 0.765,
    gridClearance: 0.1,
  });
  const withRotation = generateBiscuitBoardHypergraph(input, {
    gridPitch: 0.765,
    gridClearance: 0.1,
    respectObstacleRotationInGraph: true,
  });
  const hasRotatedEnvelopeSweepNode = (graph: typeof withRotation) =>
    graph.nodes.some(
      (node) =>
        Math.abs(node.x - 2.075) < 1e-6 && Math.abs(node.y - 4.665) < 1e-6,
    );

  expect(hasRotatedEnvelopeSweepNode(withoutRotation)).toBe(false);
  expect(hasRotatedEnvelopeSweepNode(withRotation)).toBe(true);
});

test("fine-pitch escape guides honor increased trace-to-pad clearance", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 15, maxY: 15 },
    layerCount: 1,
    minTraceWidth: 0.2,
    minTraceToPadEdgeClearance: 0.2,
    connections: [
      {
        name: "source_trace_1",
        width: 0.2,
        pointsToConnect: [
          { x: 11, y: 7, layer: "top", pointId: "far-pad" },
          { x: 8, y: 4, layer: "top", pointId: "fine-pitch-pad" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: 11, y: 7 },
        width: 0.5,
        height: 0.5,
        layers: ["top"],
        connectedTo: ["source_trace_1", "far-pad"],
      },
      {
        type: "rect",
        center: { x: 8, y: 4 },
        width: 0.85,
        height: 0.2,
        layers: ["top"],
        connectedTo: ["source_trace_1", "fine-pitch-pad"],
      },
    ],
  };
  const prepared = generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.2,
  });
  const guideEdges = prepared.edges
    .filter(
      (
        edge,
      ): edge is Extract<(typeof prepared.edges)[number], { kind: "trace" }> =>
        edge.kind === "trace" &&
        edge.restrictedToConnectionName === "source_trace_1",
    )
    .sort(
      (left, right) =>
        (left.restrictedGuideOrder ?? 0) - (right.restrictedGuideOrder ?? 0),
    );

  expect(guideEdges).toHaveLength(2);
  expect(
    Math.max(
      prepared.nodes[guideEdges[1]!.fromNode]!.x,
      prepared.nodes[guideEdges[1]!.toNode]!.x,
    ),
  ).toBeCloseTo(8.825);

  const solver = new RipUpRubberBandSolver(prepared);
  solver.solve();
  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
});

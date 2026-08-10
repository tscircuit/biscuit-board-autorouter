import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { generateBiscuitBoardHypergraph } from "../lib";
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

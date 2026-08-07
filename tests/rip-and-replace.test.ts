import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";

test("rips a crossing route and requeues it onto a clear corridor", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles: [],
    connections: [
      {
        name: "a-vertical",
        pointsToConnect: [
          { x: 5, y: 1, layer: "top", pointId: "a-start" },
          { x: 5, y: 9, layer: "top", pointId: "a-end" },
        ],
      },
      {
        name: "b-horizontal",
        pointsToConnect: [
          { x: 1, y: 5, layer: "top", pointId: "b-start" },
          { x: 9, y: 5, layer: "top", pointId: "b-end" },
        ],
      },
    ],
  };
  const solver = new BiscuitBoardRoutingPipelineSolver(input, {
    ripCost: 0.1,
    historyIncrement: 10,
  });
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  expect(solver.getOutput()!.stats.ripCount).toBeGreaterThan(0);
  expect(solver.getOutput()!.routes).toHaveLength(2);
});

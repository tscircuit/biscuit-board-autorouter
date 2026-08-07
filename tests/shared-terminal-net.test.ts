import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import {
  BiscuitBoardRoutingPipelineSolver,
  generateBiscuitBoardHypergraph,
} from "../lib";

test("connections sharing a terminal are routed as one electrical net", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles: [],
    connections: [
      {
        name: "left-branch",
        pointsToConnect: [
          { x: 1, y: 5, layer: "top", pointId: "left" },
          { x: 5, y: 5, layer: "top", pointId: "shared" },
        ],
      },
      {
        name: "right-branch",
        pointsToConnect: [
          { x: 5, y: 5, layer: "top", pointId: "shared" },
          { x: 9, y: 5, layer: "top", pointId: "right" },
        ],
      },
    ],
  };
  const prepared = generateBiscuitBoardHypergraph(input);

  expect(new Set(prepared.demands.map((demand) => demand.netId)).size).toBe(1);

  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  solver.solve();
  expect(solver.solved).toBe(true);
  expect(solver.failed).toBe(false);
  expect(solver.getOutput()!.traces).toHaveLength(2);
});

import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { BiscuitBoardWorkerPool } from "../lib/biscuit-board-worker-pool";

const makeInput = (name: string): SimpleRouteJson => ({
  bounds: { minX: -5, maxX: 5, minY: -3, maxY: 3 },
  layerCount: 1,
  minTraceWidth: 0.15,
  obstacles: [],
  connections: [
    {
      name,
      pointsToConnect: [
        { x: -3, y: 0, layer: "top", pointId: `${name}-left` },
        { x: 3, y: 0, layer: "top", pointId: `${name}-right` },
      ],
    },
  ],
});

test("routes independent boards through a persistent worker pool", async () => {
  const pool = new BiscuitBoardWorkerPool({ size: 2 });
  try {
    const first = await pool.routeMany([makeInput("a"), makeInput("b")], {
      expandTraces: false,
    });
    const second = await pool.route(makeInput("c"), { expandTraces: false });

    expect(first).toHaveLength(2);
    expect(first.every((traces) => traces.length === 1)).toBe(true);
    expect(second).toHaveLength(1);
  } finally {
    await pool.close();
  }
});

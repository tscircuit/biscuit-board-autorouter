import { expect, test } from "bun:test";
import type { GraphicsObject } from "graphics-debug";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import { forcedPrefabricatedViaFixture } from "./fixtures/forced-prefabricated-via";

const graphicPrimitiveCount = (graphics: GraphicsObject) =>
  (graphics.lines?.length ?? 0) +
  (graphics.points?.length ?? 0) +
  (graphics.rects?.length ?? 0) +
  (graphics.circles?.length ?? 0);

test("every pipeline stage exposes a meaningful visualization", () => {
  const pipeline = new BiscuitBoardRoutingPipelineSolver(
    forcedPrefabricatedViaFixture,
  );

  const initialGraphics = pipeline.initialVisualize();
  expect(initialGraphics.title).toContain("routing input");
  expect(graphicPrimitiveCount(initialGraphics)).toBeGreaterThan(0);

  pipeline.solve();
  expect(pipeline.solved).toBe(true);

  const stageNames = [
    "generate-hypergraph",
    "route-with-rip-and-replace",
    "build-and-validate-traces",
    "post-process-traces",
    "beautify-traces",
    "expand-traces",
  ] as const;
  for (const stageName of stageNames) {
    const stage = pipeline.getSolver(stageName);
    expect(stage).toBeDefined();
    const graphics = stage!.visualize();
    expect(graphics.title?.length).toBeGreaterThan(0);
    expect(graphicPrimitiveCount(graphics)).toBeGreaterThan(0);
  }
});

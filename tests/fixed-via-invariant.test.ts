import "bun-match-svg";
import { describe, expect, test } from "bun:test";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  BiscuitBoardAutorouter,
  BiscuitBoardRoutingPipelineSolver,
  Pipeline7Solver,
} from "../lib";
import { forcedPrefabricatedViaFixture } from "./fixtures/forced-prefabricated-via";

const pointKey = (point: { x: number; y: number }): string =>
  `${point.x.toFixed(3)},${point.y.toFixed(3)}`;

describe("Pipeline7 prefabricated-via post-processing", () => {
  test("moves Pipeline7's manufacturing via to the prefabricated via", () => {
    const pipeline7 = new Pipeline7Solver({
      input: forcedPrefabricatedViaFixture,
      options: { effort: 0.1 },
    });
    pipeline7.solve();
    expect(pipeline7.solved).toBe(true);
    const rawVia = pipeline7
      .getOutput()!
      .flatMap((trace) => trace.route)
      .find((point) => point.route_type === "via")!;
    expect(pointKey(rawVia)).not.toBe(pointKey({ x: 0, y: 4 }));

    const autorouter = new BiscuitBoardAutorouter(
      forcedPrefabricatedViaFixture as never,
      { pipeline7: { effort: 0.1 } },
    );
    const traces = autorouter.solveSync();
    const routedVias = traces.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    );

    expect(routedVias.map(pointKey)).toEqual([pointKey({ x: 0, y: 4 })]);
    expect(autorouter.solver.getOutput()!.stats).toMatchObject({
      inputViaCount: 1,
      movedViaCount: 1,
    });
  });

  test("fails instead of leaving a new via when no prefab via exists", () => {
    const input = {
      ...forcedPrefabricatedViaFixture,
      obstacles: forcedPrefabricatedViaFixture.obstacles.filter(
        (obstacle) => !obstacle.netIsAssignable,
      ),
    };
    const solver = new BiscuitBoardRoutingPipelineSolver(input, {
      pipeline7: { effort: 0.1 },
    });

    expect(() => solver.solve()).toThrow("compatible prefabricated vias");
  });

  test("matches the complete Pipeline7 plus attraction debugger SVG", async () => {
    const solver = new BiscuitBoardRoutingPipelineSolver(
      forcedPrefabricatedViaFixture,
      { pipeline7: { effort: 0.1 } },
    );
    solver.solve();
    expect(solver.solved).toBe(true);

    const postProcessGraphics = solver
      .getSolver("post-process-traces")
      ?.visualize();
    expect(postProcessGraphics?.title).toContain("trace simplification");
    expect(postProcessGraphics?.rects?.length).toBeGreaterThan(0);
    expect(postProcessGraphics?.circles?.length).toBeGreaterThan(0);
    const svg = getSvgFromGraphicsObject(solver.visualize(), {
      backgroundColor: "white",
      svgWidth: 900,
      svgHeight: 600,
    });
    await expect(svg).toMatchSvgSnapshot(import.meta.path);
  });
});

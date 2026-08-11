import "bun-match-svg";
import { describe, expect, test } from "bun:test";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  BiscuitBoardAutorouter,
  BiscuitBoardRoutingPipelineSolver,
  generateBiscuitBoardHypergraph,
} from "../lib";
import { forcedPrefabricatedViaFixture } from "./fixtures/forced-prefabricated-via";

const pointKey = (point: { x: number; y: number }) =>
  `${point.x.toFixed(3)},${point.y.toFixed(3)}`;

describe("fixed-via invariant", () => {
  test("the generated hypergraph only changes layers at prefabricated vias", () => {
    const prepared = generateBiscuitBoardHypergraph(
      forcedPrefabricatedViaFixture,
    );
    const transitionEdges = prepared.edges.filter(
      (edge) => edge.kind === "fixed_via_transition",
    );

    expect(transitionEdges).toHaveLength(1);
    for (const edge of transitionEdges) {
      if (edge.kind !== "fixed_via_transition") continue;
      const via = prepared.fixedViaById.get(edge.prefabViaId);
      const from = prepared.nodes[edge.fromNode]!;
      const to = prepared.nodes[edge.toNode]!;
      expect(via).toBeDefined();
      expect(pointKey(from)).toBe(pointKey(via!));
      expect(pointKey(to)).toBe(pointKey(via!));
      expect(from.layer).not.toBe(to.layer);
    }
  });

  test("routes a forced layer change through the existing via", () => {
    const autorouter = new BiscuitBoardAutorouter(
      forcedPrefabricatedViaFixture,
    );
    const traces = autorouter.solveSync();
    const routedVias = traces.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "through_obstacle"),
    );

    expect(routedVias.map((point) => pointKey(point.start))).toEqual([
      pointKey({ x: 0, y: 4 }),
    ]);
    expect(autorouter.solver.getOutput()!.stats.fixedViaTransitionCount).toBe(
      1,
    );
  });

  test("cannot represent a layer change when there is no prefabricated via", () => {
    const input = {
      ...forcedPrefabricatedViaFixture,
      obstacles: forcedPrefabricatedViaFixture.obstacles.filter(
        (obstacle) => !obstacle.netIsAssignable,
      ),
    };
    const solver = new BiscuitBoardRoutingPipelineSolver(input, {
      maxSearchStates: 20_000,
    });
    solver.solve();

    expect(solver.solved).toBe(false);
    expect(solver.failed).toBe(true);
    expect(solver.error).toContain("No fixed-via route found");
  });

  test("does not mistake an assignable plated hole for a prefabricated via", () => {
    const input = {
      ...forcedPrefabricatedViaFixture,
      obstacles: forcedPrefabricatedViaFixture.obstacles.map((obstacle) =>
        obstacle.netIsAssignable
          ? { ...obstacle, connectedTo: ["pcb_plated_hole_usb_shell"] }
          : obstacle,
      ),
    };
    const prepared = generateBiscuitBoardHypergraph(input);

    expect(prepared.prefabricatedVias).toEqual([]);
    expect(
      prepared.edges.filter((edge) => edge.kind === "fixed_via_transition"),
    ).toEqual([]);
  });

  test("matches the routing-debug SVG", async () => {
    const solver = new BiscuitBoardRoutingPipelineSolver(
      forcedPrefabricatedViaFixture,
    );
    solver.solve();
    expect(solver.solved).toBe(true);

    const wireCoordinates = solver
      .getOutput()!
      .traces[0]!.route.flatMap((point) =>
        point.route_type === "wire"
          ? [[point.x, point.y, point.layer] as const]
          : [],
      );
    expect(wireCoordinates).toEqual([
      [-5.5, 0, "top"],
      [-1.5, 4, "top"],
      [0, 4, "top"],
      [0, 4, "bottom"],
      [1.5, 4, "bottom"],
      [5.5, 0, "bottom"],
    ]);
    expect(wireCoordinates).not.toContainEqual([-5.5, 4, "top"]);
    expect(wireCoordinates).not.toContainEqual([5.5, 4, "bottom"]);

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

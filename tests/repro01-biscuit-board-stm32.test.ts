import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { measureTraceWidths } from "@tscircuit/power-trace-expander";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  BeautifyBiscuitBoardTracesSolver,
  BiscuitBoardRoutingPipelineSolver,
  ExpandBiscuitBoardTracesSolver,
  getTraceClearanceViolations,
  type BiscuitBoardRoutingSolution,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import fixedPostProcessed from "../repros/fixtures/repro01-biscuit-board-stm32.post-processed.json";
import capturedInput from "../repros/fixtures/repro01-biscuit-board-stm32.srj.json";

const input = capturedInput as SimpleRouteJson;
const snapshotInput = fixedPostProcessed as BiscuitBoardRoutingSolution;
const pointKey = (point: { x: number; y: number }) =>
  `${point.x.toFixed(3)},${point.y.toFixed(3)}`;

test("solves and beautifies the exact BiscuitBoard STM32C071 real-project input", async () => {
  const assignableViaPositions = new Set(
    input.obstacles
      .filter((obstacle) => obstacle.netIsAssignable)
      .map((obstacle) => pointKey(obstacle.center)),
  );

  expect(input.connections).toHaveLength(9);
  expect(input.obstacles).toHaveLength(100);
  expect(assignableViaPositions).toHaveLength(54);

  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  const output = solver.getOutput();
  expect(output).not.toBeNull();
  // Same-layer crossings between branches are physical copper connections,
  // even when the sparse graph does not place a node at the intersection.
  expect(output!.traces).toHaveLength(17);
  expect(output!.stats.postProcessedClearance).toBe(0.2);
  expect(output!.stats.preSimplificationSegmentCount).toBeGreaterThan(0);
  expect(output!.stats.postSimplificationSegmentCount).toBeLessThan(
    output!.stats.preSimplificationSegmentCount! * 0.5,
  );
  expect(output!.stats.fortyFiveDegreeChamferCount).toBeGreaterThan(0);
  expect(output!.stats.fixedViaTransitionCount).toBe(0);
  const postProcessed = solver.getStageOutput("post-process-traces")!;
  const beautified = solver.getStageOutput("beautify-traces")!;
  expect(beautified.traces).not.toEqual(postProcessed.traces);
  const prepared = solver.getStageOutput<PreparedBiscuitRoutingProblem>(
    "generate-hypergraph",
  );
  expect(prepared).toBeDefined();
  expect(getTraceClearanceViolations(prepared!, output!)).toEqual([]);
  expect(
    output!.traces
      .flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "through_obstacle")
      .every((via) => assignableViaPositions.has(pointKey(via.start))),
  ).toBe(true);
  for (const trace of output!.traces) {
    for (let index = 1; index < trace.route.length; index++) {
      const start = trace.route[index - 1]!;
      const end = trace.route[index]!;
      if (
        start.route_type !== "wire" ||
        end.route_type !== "wire" ||
        start.layer !== end.layer
      ) {
        continue;
      }
      const dx = Math.abs(end.x - start.x);
      const dy = Math.abs(end.y - start.y);
      expect(Math.hypot(dx, dy)).toBeGreaterThan(1e-7);
      expect(dx < 1e-7 || dy < 1e-7 || Math.abs(dx - dy) < 1e-7).toBe(true);
    }
  }

  const targetInput = {
    ...prepared!.input,
    nominalTraceWidth: 0.3,
    connections: prepared!.input.connections.map((connection) => ({
      ...connection,
      nominalTraceWidth: 0.3,
    })),
  };
  const expansionSolver = new ExpandBiscuitBoardTracesSolver({
    prepared: { ...prepared!, input: targetInput },
    built: output!,
  });
  expansionSolver.solve();
  const expanded = expansionSolver.getOutput()!;
  const metrics = measureTraceWidths(targetInput, expanded.traces).get(0.3)!;
  expect(expansionSolver.failed).toBe(false);
  expect(metrics.nominalCoverage).toBeGreaterThan(0.8);
  expect(metrics.normalizedWidthDeficit).toBeLessThan(0.1);
  expect(
    expanded.traces.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    ),
  ).toEqual([]);
  // The rip-and-replace route is valid but can differ across CPU architectures.
  // Keep the end-to-end assertions above, while snapshotting the beautifier from
  // a fixed post-processing boundary so the SVG is stable on macOS and Linux.
  const snapshotBeautifier = new BeautifyBiscuitBoardTracesSolver({
    prepared: prepared!,
    built: snapshotInput,
  });
  snapshotBeautifier.solve();
  expect(snapshotBeautifier.failed).toBe(false);
  const beautificationGraphics = snapshotBeautifier.visualize();
  expect(beautificationGraphics.rects?.length).toBeGreaterThan(0);
  expect(beautificationGraphics.circles?.length).toBeGreaterThan(0);
  const obstacleLabels = [
    ...(beautificationGraphics.rects ?? []),
    ...(beautificationGraphics.circles ?? []),
  ].map((shape) => shape.label ?? "");
  expect(obstacleLabels.some((label) => label.startsWith("obstacle ·"))).toBe(
    true,
  );
  expect(
    obstacleLabels.some((label) => label.includes("prefabricated via")),
  ).toBe(true);
  const svg = getSvgFromGraphicsObject(beautificationGraphics, {
    backgroundColor: "white",
    svgWidth: 1200,
    svgHeight: 900,
  });
  await expect(svg).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

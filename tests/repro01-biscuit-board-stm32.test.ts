import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import {
  BiscuitBoardRoutingPipelineSolver,
  getTraceClearanceViolations,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import capturedInput from "../repros/fixtures/repro01-biscuit-board-stm32.srj.json";

const input = capturedInput as SimpleRouteJson;
const pointKey = (point: { x: number; y: number }) =>
  `${point.x.toFixed(3)},${point.y.toFixed(3)}`;

test("solves the exact BiscuitBoard STM32C071 real-project input", () => {
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
  // The 17 original branch demands need two additional same-net Steiner
  // bridges after rip-and-replace to keep every terminal component connected.
  expect(output!.traces).toHaveLength(19);
  expect(output!.stats.postProcessedClearance).toBe(0.2);
  expect(output!.stats.preSimplificationSegmentCount).toBeGreaterThan(0);
  expect(output!.stats.postSimplificationSegmentCount).toBeLessThan(
    output!.stats.preSimplificationSegmentCount! * 0.4,
  );
  expect(output!.stats.fixedViaTransitionCount).toBe(0);
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
}, 30_000);

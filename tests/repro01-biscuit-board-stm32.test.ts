import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
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
  expect(input.obstacles).toHaveLength(97);
  expect(assignableViaPositions).toHaveLength(51);

  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  const output = solver.getOutput();
  expect(output).not.toBeNull();
  expect(output!.traces).toHaveLength(17);
  expect(output!.stats.inputViaCount).toBeGreaterThanOrEqual(0);
  expect(
    output!.traces
      .flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "via").length,
  ).toBe(0);
  expect(
    output!.traces
      .flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "through_obstacle")
      .every((transition) =>
        assignableViaPositions.has(pointKey(transition.start)),
      ),
  ).toBe(true);
}, 30_000);

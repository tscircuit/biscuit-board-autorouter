import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  BiscuitBoardRoutingPipelineSolver,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import capturedInput from "../repros/fixtures/repro03-stm32-display-user-led.srj.json";

const input = capturedInput as SimpleRouteJson;
const R_USER_LED_CENTER = { x: 22.5, y: 12 };
const R_USER_LED_VIEWBOX_MARGIN = 5;
const VIEWBOX_MARKER_LABEL = "R_USER_LED 5mm snapshot viewbox";

const cropSvgToRUserLed = (svg: string) => {
  const markerMatch = svg.match(
    new RegExp(`data-label="${VIEWBOX_MARKER_LABEL}" points="([^"]+)"`),
  );
  if (!markerMatch?.[1]) {
    throw new Error("Could not find the R_USER_LED viewbox marker in the SVG");
  }
  const [first, second] = markerMatch[1].split(" ").map((point) => {
    const [x, y] = point.split(",").map(Number);
    return { x: x!, y: y! };
  });
  if (!first || !second) {
    throw new Error("The R_USER_LED viewbox marker has invalid points");
  }
  const minX = Math.min(first.x, second.x);
  const minY = Math.min(first.y, second.y);
  const width = Math.abs(second.x - first.x);
  const height = Math.abs(second.y - first.y);

  return svg.replace(
    /viewBox="[^"]+"/,
    `viewBox="${minX} ${minY} ${width} ${height}"`,
  );
};

test("keeps expanded routing regular around R_USER_LED on the STM32 display board", async () => {
  expect(input.connections).toHaveLength(17);
  expect(input.obstacles).toHaveLength(119);

  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  const output = solver.getOutput()!;
  expect(output.traces).toHaveLength(33);
  const prepared = solver.getStageOutput<PreparedBiscuitRoutingProblem>(
    "generate-hypergraph",
  )!;
  const userLedDemand = prepared.demands.find(
    (demand) => demand.connectionName === "source_trace_32",
  );
  expect(userLedDemand).toMatchObject({ width: 0.25, nominalWidth: 0.3 });

  const userLedTrace = output.traces.find(
    (trace) => trace.connection_name === "source_trace_32",
  )!;
  const userLedWirePoints = userLedTrace.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(
    userLedWirePoints.slice(0, -1).every((start, index) => {
      const end = userLedWirePoints[index + 1]!;
      const dx = Math.abs(end.x - start.x);
      const dy = Math.abs(end.y - start.y);
      return dx < 1e-7 || dy < 1e-7 || Math.abs(dx - dy) < 1e-7;
    }),
  ).toBe(true);
  expect(
    userLedWirePoints.filter(
      (point) =>
        Math.abs(point.x - R_USER_LED_CENTER.x) <= R_USER_LED_VIEWBOX_MARGIN &&
        Math.abs(point.y - R_USER_LED_CENTER.y) <= R_USER_LED_VIEWBOX_MARGIN,
    ).length,
  ).toBeLessThanOrEqual(3);
  expect(userLedWirePoints.every((point) => point.width === 0.3)).toBe(true);

  const margin = R_USER_LED_VIEWBOX_MARGIN;
  const graphics = solver.visualize();
  const graphicsWithViewboxMarker = {
    ...graphics,
    lines: [
      ...(graphics.lines ?? []),
      {
        points: [
          {
            x: R_USER_LED_CENTER.x - margin,
            y: R_USER_LED_CENTER.y - margin,
          },
          {
            x: R_USER_LED_CENTER.x + margin,
            y: R_USER_LED_CENTER.y + margin,
          },
        ],
        label: VIEWBOX_MARKER_LABEL,
        strokeColor: "transparent",
      },
    ],
  };
  const fullSvg = getSvgFromGraphicsObject(graphicsWithViewboxMarker, {
    backgroundColor: "white",
    svgWidth: 1200,
    svgHeight: 1200,
  });
  const croppedSvg = cropSvgToRUserLed(fullSvg);

  await expect(croppedSvg).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

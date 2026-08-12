import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "../repros/fixtures/repro03-stm32-display-user-led.srj.json";

const input = capturedInput as SimpleRouteJson;
const POWER_LED_CENTER = { x: 6.75, y: 15 };
const POWER_LED_VIEWBOX_MARGIN = 5;
const VIEWBOX_MARKER_LABEL = "R_PWR_LED and D_PWR 5mm snapshot viewbox";
const POWER_LED_PAD_CENTERS = [
  { x: 4.175, y: 15 },
  { x: 5.825, y: 15 },
  { x: 7.675, y: 15 },
  { x: 9.325, y: 15 },
];

const cropSvgToPowerLed = (svg: string) => {
  const markerMatch = svg.match(
    new RegExp(`data-label="${VIEWBOX_MARKER_LABEL}" points="([^"]+)"`),
  );
  if (!markerMatch?.[1]) {
    throw new Error("Could not find the power LED viewbox marker in the SVG");
  }
  const [first, second] = markerMatch[1].split(" ").map((point) => {
    const [x, y] = point.split(",").map(Number);
    return { x: x!, y: y! };
  });
  if (!first || !second) {
    throw new Error("The power LED viewbox marker has invalid points");
  }
  return svg.replace(
    /viewBox="[^"]+"/,
    `viewBox="${Math.min(first.x, second.x)} ${Math.min(first.y, second.y)} ${Math.abs(second.x - first.x)} ${Math.abs(second.y - first.y)}"`,
  );
};

const isOctilinear = (
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  return dx < 1e-7 || dy < 1e-7 || Math.abs(dx - dy) < 1e-5;
};

test("keeps expanded routing regular around R_PWR_LED and D_PWR", async () => {
  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  const output = solver.getOutput()!;
  const powerLedTraces = output.traces.filter((trace) =>
    trace.route.some(
      (point) =>
        point.route_type === "wire" &&
        POWER_LED_PAD_CENTERS.some(
          (pad) =>
            Math.abs(point.x - pad.x) < 1e-7 &&
            Math.abs(point.y - pad.y) < 1e-7,
        ),
    ),
  );
  expect(powerLedTraces).toHaveLength(4);
  for (const trace of powerLedTraces) {
    const wirePoints = trace.route.filter(
      (point) => point.route_type === "wire",
    );
    expect(wirePoints.every((point) => point.width === 0.3)).toBe(true);
    expect(
      trace.route.slice(0, -1).every((start, index) => {
        const end = trace.route[index + 1]!;
        return (
          start.route_type !== "wire" ||
          end.route_type !== "wire" ||
          start.layer !== end.layer ||
          isOctilinear(start, end)
        );
      }),
    ).toBe(true);
  }

  const margin = POWER_LED_VIEWBOX_MARGIN;
  const graphics = solver.visualize();
  const graphicsWithViewboxMarker = {
    ...graphics,
    lines: [
      ...(graphics.lines ?? []),
      {
        points: [
          { x: POWER_LED_CENTER.x - margin, y: POWER_LED_CENTER.y - margin },
          { x: POWER_LED_CENTER.x + margin, y: POWER_LED_CENTER.y + margin },
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

  await expect(cropSvgToPowerLed(fullSvg)).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

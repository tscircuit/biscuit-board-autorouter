import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
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

test("reproduces irregular routing around R_USER_LED on the STM32 display board", async () => {
  expect(input.connections).toHaveLength(17);
  expect(input.obstacles).toHaveLength(119);

  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  expect(solver.getOutput()?.traces).toHaveLength(33);

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

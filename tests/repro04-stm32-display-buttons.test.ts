import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "../repros/fixtures/repro04-stm32-display-buttons.srj.json";

const input = capturedInput as SimpleRouteJson;
const BUTTON_CENTERS = [
  { x: -30, y: 8 },
  { x: -30, y: -8 },
] as const;
const BUTTON_VIEWBOX_MARGIN = 5;
const VIEWBOX_MARKER_LABEL = "BTN1/BTN2 5mm snapshot viewbox";

const cropSvgToButtons = (svg: string) => {
  const markerMatch = svg.match(
    new RegExp(`data-label="${VIEWBOX_MARKER_LABEL}" points="([^"]+)"`),
  );
  if (!markerMatch?.[1]) {
    throw new Error("Could not find the BTN1/BTN2 viewbox marker in the SVG");
  }
  const [first, second] = markerMatch[1].split(" ").map((point) => {
    const [x, y] = point.split(",").map(Number);
    return { x: x!, y: y! };
  });
  if (!first || !second) {
    throw new Error("The BTN1/BTN2 viewbox marker has invalid points");
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

test("reproduces irregular traces between BTN1 and BTN2 on the STM32 display board", async () => {
  expect(input.connections).toHaveLength(17);
  expect(input.obstacles).toHaveLength(119);

  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  expect(solver.getOutput()?.traces).toHaveLength(33);

  const xs = BUTTON_CENTERS.map(({ x }) => x);
  const ys = BUTTON_CENTERS.map(({ y }) => y);
  const margin = BUTTON_VIEWBOX_MARGIN;
  const graphics = solver.visualize();
  const graphicsWithViewboxMarker = {
    ...graphics,
    lines: [
      ...(graphics.lines ?? []),
      {
        points: [
          {
            x: Math.min(...xs) - margin,
            y: Math.min(...ys) - margin,
          },
          {
            x: Math.max(...xs) + margin,
            y: Math.max(...ys) + margin,
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
  const croppedSvg = cropSvgToButtons(fullSvg);

  await expect(croppedSvg).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

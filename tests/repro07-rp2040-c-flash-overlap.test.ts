import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  BiscuitBoardRoutingPipelineSolver,
  getTraceClearanceViolations,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import capturedInput from "../repros/fixtures/repro07-rp2040-c-flash-overlap.srj.json";

const input = capturedInput as SimpleRouteJson;
const U_FLASH_COMPONENT_ID = "pcb_component_64";
const C_FLASH_COMPONENT_ID = "pcb_component_65";
const C_FLASH_CENTER = { x: 1, y: -1.8 };
const VIEWBOX_MARGIN = 5;
const VIEWBOX_MARKER_LABEL = "C_FLASH 10mm snapshot viewbox";

const cropSvgToCFlash = (svg: string) => {
  const markerMatch = svg.match(
    new RegExp(`data-label="${VIEWBOX_MARKER_LABEL}" points="([^"]+)"`),
  );
  if (!markerMatch?.[1]) {
    throw new Error("Could not find the C_FLASH viewbox marker in the SVG");
  }
  const [first, second] = markerMatch[1].split(" ").map((point) => {
    const [x, y] = point.split(",").map(Number);
    return { x: x!, y: y! };
  });
  if (!first || !second) throw new Error("Invalid C_FLASH viewbox marker");
  const minX = Math.min(first.x, second.x);
  const minY = Math.min(first.y, second.y);
  const width = Math.abs(second.x - first.x);
  const height = Math.abs(second.y - first.y);

  return svg
    .replace(/viewBox="[^"]+"/, `viewBox="${minX} ${minY} ${width} ${height}"`)
    .replace(
      '<rect width="100%" height="100%" fill="white"/>',
      `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="white"/>`,
    );
};

test("reproduces the C_FLASH route underneath the RP2040 flash chip without an error", async () => {
  expect(input.connections).toHaveLength(28);
  expect(input.obstacles).toHaveLength(209);
  expect(
    input.obstacles.filter(
      (obstacle) => obstacle.componentId === U_FLASH_COMPONENT_ID,
    ),
  ).toHaveLength(8);
  expect(
    input.obstacles.filter(
      (obstacle) => obstacle.componentId === C_FLASH_COMPONENT_ID,
    ),
  ).toHaveLength(2);

  const solver = new BiscuitBoardRoutingPipelineSolver(input, {
    gridClearance: 0.1,
    expandTraces: true,
    maxBlockersPerSearch: 1_024,
    maxRipsPerRoute: 1_000,
    maxTotalRips: 10_000,
    maxSearchStates: 2_000_000,
    routeOrder: "input",
  });
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  const output = solver.getOutput()!;
  expect(output.traces).toHaveLength(82);
  const prepared = solver.getStageOutput<PreparedBiscuitRoutingProblem>(
    "generate-hypergraph",
  );
  expect(prepared).toBeDefined();
  expect(getTraceClearanceViolations(prepared!, output)).toEqual([]);

  const graphics = solver.visualize();
  const margin = VIEWBOX_MARGIN;
  const annotatedGraphics = {
    ...graphics,
    rects: [
      ...(graphics.rects ?? []),
      {
        center: { x: 1, y: 0.15 },
        width: 3,
        height: 2,
        fill: "rgba(219,39,119,0.06)",
        stroke: "#db2777",
        label: "U_FLASH body outline from source footprint",
      },
    ],
    lines: [
      ...(graphics.lines ?? []),
      {
        points: [
          {
            x: C_FLASH_CENTER.x - margin,
            y: C_FLASH_CENTER.y - margin,
          },
          {
            x: C_FLASH_CENTER.x + margin,
            y: C_FLASH_CENTER.y + margin,
          },
        ],
        label: VIEWBOX_MARKER_LABEL,
        strokeColor: "transparent",
      },
    ],
    texts: [
      ...(graphics.texts ?? []),
      { x: 1, y: 1.55, text: "U_FLASH body", fontSize: 0.42 },
      { x: 1, y: -3.15, text: "C_FLASH", fontSize: 0.42 },
      {
        x: 1,
        y: -3.75,
        text: "route completes with no clearance error",
        fontSize: 0.36,
      },
    ],
  };
  const fullSvg = getSvgFromGraphicsObject(annotatedGraphics, {
    backgroundColor: "white",
    svgWidth: 1200,
    svgHeight: 1200,
  });

  await expect(cropSvgToCFlash(fullSvg)).toMatchSvgSnapshot(import.meta.path);
}, 120_000);

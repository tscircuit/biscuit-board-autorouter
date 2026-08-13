import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "../repros/fixtures/repro05-stm32-display-redundant-gnd-branch.srj.json";

const input = capturedInput as SimpleRouteJson;
const C_MCU_GND = { id: "pcb_port_199", x: 12.5, y: 1.9125 };
const C_NRST_GND = { id: "pcb_port_201", x: 14, y: 6.9125 };
const D_PWR_GND = { id: "pcb_port_207", x: 9.325, y: 15 };
const GND_VIA = { id: "pcb_via_12", x: 12.75, y: 19.5 };
const VIEWBOX_MARKER_LABEL = "redundant GND branch snapshot viewbox";

const cropSvgToIssue = (svg: string) => {
  const markerMatch = svg.match(
    new RegExp(`data-label="${VIEWBOX_MARKER_LABEL}" points="([^"]+)"`),
  );
  if (!markerMatch?.[1]) {
    throw new Error("Could not find the redundant-branch viewbox marker");
  }
  const [first, second] = markerMatch[1].split(" ").map((point) => {
    const [x, y] = point.split(",").map(Number);
    return { x: x!, y: y! };
  });
  if (!first || !second) throw new Error("Invalid issue viewbox marker");
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

test("removes the redundant C_MCU-to-via GND branch", async () => {
  expect(input.connections).toHaveLength(17);
  expect(input.obstacles).toHaveLength(119);
  expect(input.minBoardEdgeClearance).toBe(0.35);
  expect(
    input.obstacles.some(
      (obstacle) =>
        obstacle.netIsAssignable === true &&
        obstacle.connectedTo.includes(GND_VIA.id) &&
        obstacle.center.x === GND_VIA.x &&
        obstacle.center.y === GND_VIA.y,
    ),
  ).toBe(true);

  const solver = new BiscuitBoardRoutingPipelineSolver(input, {
    routeOrder: "input",
  });
  solver.solve();

  expect(solver.failed).toBe(false);
  expect(solver.solved).toBe(true);
  const output = solver.getOutput()!;
  expect(output.traces).toHaveLength(33);

  const traceWith = (...ids: string[]) =>
    output.traces.find((trace) =>
      ids.every((id) => trace.connectsTo?.includes(id)),
    );
  const cmcuToCnrst = traceWith(C_MCU_GND.id, C_NRST_GND.id);
  const cnrstToDPwr = traceWith(C_NRST_GND.id, D_PWR_GND.id);
  const cmcuToVia = traceWith(C_MCU_GND.id, GND_VIA.id);
  expect(cmcuToCnrst).toBeDefined();
  expect(cnrstToDPwr).toBeDefined();
  expect(cmcuToVia).toBeUndefined();

  const graphics = solver.visualize();
  const annotatedGraphics = {
    ...graphics,
    lines: [
      ...(graphics.lines ?? []),
      {
        points: [
          { x: 4.5, y: 0 },
          { x: 20.25, y: 21 },
        ],
        strokeColor: "transparent",
        label: VIEWBOX_MARKER_LABEL,
      },
    ],
    texts: [
      ...(graphics.texts ?? []),
      { x: 11.7, y: 0.85, text: "C_MCU GND", fontSize: 0.42 },
      { x: 14.35, y: 6.7, text: "C_NRST GND", fontSize: 0.42 },
      { x: 7.8, y: 15.65, text: "D_PWR GND", fontSize: 0.42 },
      { x: 12.75, y: 20.5, text: "prefabricated via", fontSize: 0.42 },
      { x: 14.7, y: 11.25, text: "redundant branch removed", fontSize: 0.42 },
    ],
  };
  const fullSvg = getSvgFromGraphicsObject(annotatedGraphics, {
    backgroundColor: "white",
    svgWidth: 900,
    svgHeight: 1200,
  });

  await expect(cropSvgToIssue(fullSvg)).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

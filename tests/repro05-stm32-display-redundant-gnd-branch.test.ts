import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "../repros/fixtures/repro05-stm32-display-redundant-gnd-branch.srj.json";

const input = capturedInput as SimpleRouteJson;
const C_MCU_GND = { id: "pcb_port_199", x: 12.5, y: 1.9125 };
const C_NRST_GND = { id: "pcb_port_201", x: 14, y: 6.9125 };
const D_PWR_GND = { id: "pcb_port_207", x: 9.325, y: 15 };
const GND_VIA = { id: "pcb_via_12", x: 12.75, y: 19.5 };
const VIEWBOX_MARKER_LABEL = "redundant GND branch snapshot viewbox";

type WirePoint = Extract<
  SimplifiedPcbTrace["route"][number],
  { route_type: "wire" }
>;

const wireSegments = (trace: SimplifiedPcbTrace) =>
  trace.route.flatMap((point, index) => {
    const next = trace.route[index + 1];
    return point.route_type === "wire" &&
      next?.route_type === "wire" &&
      point.layer === next.layer
      ? [{ start: point, end: next }]
      : [];
  });

const cross = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) => first.x * second.y - first.y * second.x;

const subtract = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) => ({ x: first.x - second.x, y: first.y - second.y });

const getProperIntersection = (
  first: { start: WirePoint; end: WirePoint },
  second: { start: WirePoint; end: WirePoint },
) => {
  const firstVector = subtract(first.end, first.start);
  const secondVector = subtract(second.end, second.start);
  const denominator = cross(firstVector, secondVector);
  if (Math.abs(denominator) < 1e-9) return null;
  const betweenStarts = subtract(second.start, first.start);
  const firstRatio = cross(betweenStarts, secondVector) / denominator;
  const secondRatio = cross(betweenStarts, firstVector) / denominator;
  const epsilon = 1e-7;
  if (
    firstRatio <= epsilon ||
    firstRatio >= 1 - epsilon ||
    secondRatio <= epsilon ||
    secondRatio >= 1 - epsilon
  ) {
    return null;
  }
  return {
    x: first.start.x + firstVector.x * firstRatio,
    y: first.start.y + firstVector.y * firstRatio,
  };
};

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

test("reproduces the redundant C_MCU-to-via GND branch", async () => {
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

  const solver = new BiscuitBoardRoutingPipelineSolver(input);
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
  expect(cmcuToVia).toBeDefined();

  const cmcuToViaStart = cmcuToVia!.route.find(
    (point): point is WirePoint => point.route_type === "wire",
  );
  expect(cmcuToViaStart).toMatchObject({
    x: C_MCU_GND.x,
    y: C_MCU_GND.y,
    layer: "top",
  });

  const crossing = wireSegments(cmcuToVia!)
    .flatMap((viaSegment) =>
      wireSegments(cnrstToDPwr!).flatMap((powerSegment) => {
        const intersection = getProperIntersection(viaSegment, powerSegment);
        return intersection ? [intersection] : [];
      }),
    )
    .at(0);
  expect(crossing).toBeDefined();
  expect(crossing!.x).toBeCloseTo(GND_VIA.x, 5);
  expect(crossing!.y).toBeGreaterThan(C_NRST_GND.y);
  expect(crossing!.y).toBeLessThan(GND_VIA.y);

  const graphics = solver.visualize();
  const annotatedGraphics = {
    ...graphics,
    lines: [
      ...(graphics.lines ?? []),
      {
        points: [C_MCU_GND, { x: GND_VIA.x, y: 2.1625 }, crossing!],
        strokeColor: "#dc2626",
        strokeWidth: 0.13,
        zIndex: 10,
        label: "redundant same-net copper",
      },
      {
        points: [crossing!, GND_VIA],
        strokeColor: "#84cc16",
        strokeWidth: 0.13,
        strokeDash: [0.2, 0.1],
        zIndex: 11,
        label: "required connection to prefabricated via",
      },
      {
        points: [
          { x: 4.5, y: 0 },
          { x: 20.25, y: 21 },
        ],
        strokeColor: "transparent",
        label: VIEWBOX_MARKER_LABEL,
      },
    ],
    circles: [
      ...(graphics.circles ?? []),
      {
        center: crossing!,
        radius: 0.22,
        fill: "#facc15",
        stroke: "#854d0e",
        label: "same-net crossing where the via branch should stop",
      },
    ],
    texts: [
      ...(graphics.texts ?? []),
      { x: 11.7, y: 0.85, text: "C_MCU GND", fontSize: 0.42 },
      { x: 14.35, y: 6.7, text: "C_NRST GND", fontSize: 0.42 },
      { x: 7.8, y: 15.65, text: "D_PWR GND", fontSize: 0.42 },
      { x: 12.75, y: 20.5, text: "prefabricated via", fontSize: 0.42 },
      { x: 14.7, y: 11.25, text: "trim at crossing", fontSize: 0.42 },
    ],
  };
  const fullSvg = getSvgFromGraphicsObject(annotatedGraphics, {
    backgroundColor: "white",
    svgWidth: 900,
    svgHeight: 1200,
  });

  await expect(cropSvgToIssue(fullSvg)).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

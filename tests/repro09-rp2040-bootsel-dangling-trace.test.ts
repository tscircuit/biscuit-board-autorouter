import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import { BiscuitBoardRoutingPipelineSolver } from "../lib";
import capturedInput from "../repros/fixtures/repro09-rp2040-bootsel-dangling-trace.srj.json";

const input = capturedInput as SimpleRouteJson;
const BOOTSEL_PORT = { x: 17.45, y: -7.076788, layer: "top" };
const DANGLING_ENDPOINT = { x: 18.625, y: -3.625, layer: "top" };
const VIEWBOX = { minX: 12.5, minY: -13, maxX: 27, maxY: 1 };
const VIEWBOX_MARKER_LABEL = "BOOTSEL dangling trace snapshot viewbox";
const EPSILON = 1e-6;

const isSamePoint = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) =>
  Math.abs(first.x - second.x) < EPSILON &&
  Math.abs(first.y - second.y) < EPSILON;

const pointIsOnSegment = (
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const crossProduct =
    (point.x - start.x) * (end.y - start.y) -
    (point.y - start.y) * (end.x - start.x);
  return (
    Math.abs(crossProduct) < EPSILON &&
    point.x >= Math.min(start.x, end.x) - EPSILON &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.y >= Math.min(start.y, end.y) - EPSILON &&
    point.y <= Math.max(start.y, end.y) + EPSILON
  );
};

const wirePoints = (trace: SimplifiedPcbTrace) =>
  trace.route.filter(
    (
      routePoint,
    ): routePoint is Extract<
      (typeof trace.route)[number],
      { route_type: "wire" }
    > => routePoint.route_type === "wire",
  );

const cropSvgToIssue = (svg: string) => {
  const markerMatch = svg.match(
    new RegExp(`data-label="${VIEWBOX_MARKER_LABEL}" points="([^"]+)"`),
  );
  if (!markerMatch?.[1]) throw new Error("Could not find the viewbox marker");
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

test("reproduces the dangling GND branch above RP2040 BOOTSEL", async () => {
  expect(input.connections).toHaveLength(28);
  expect(input.obstacles).toHaveLength(209);

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

  const danglingTrace = output.traces.find((trace) => {
    const points = wirePoints(trace);
    return (
      trace.connection_name === "source_net_0" &&
      points.some(
        (point) =>
          point.layer === BOOTSEL_PORT.layer &&
          isSamePoint(point, BOOTSEL_PORT),
      ) &&
      points.at(-1)?.layer === DANGLING_ENDPOINT.layer &&
      isSamePoint(points.at(-1)!, DANGLING_ENDPOINT)
    );
  });
  expect(danglingTrace).toBeDefined();

  const requestedTerminals = input.connections.find(
    (connection) => connection.name === "source_net_0",
  )!.pointsToConnect;
  expect(
    requestedTerminals.some(
      (terminal) =>
        terminal.layer === DANGLING_ENDPOINT.layer &&
        isSamePoint(terminal, DANGLING_ENDPOINT),
    ),
  ).toBe(false);

  const sameNetJunctionExists = output.traces
    .filter(
      (trace) =>
        trace !== danglingTrace && trace.connection_name === "source_net_0",
    )
    .some((trace) => {
      const points = wirePoints(trace);
      return points.slice(1).some((end, index) => {
        const start = points[index]!;
        return (
          start.layer === DANGLING_ENDPOINT.layer &&
          end.layer === DANGLING_ENDPOINT.layer &&
          pointIsOnSegment(DANGLING_ENDPOINT, start, end)
        );
      });
    });
  expect(sameNetJunctionExists).toBe(false);

  const graphics = solver.visualize();
  const fullSvg = getSvgFromGraphicsObject(
    {
      ...graphics,
      lines: [
        ...(graphics.lines ?? []),
        {
          points: [
            { x: VIEWBOX.minX, y: VIEWBOX.minY },
            { x: VIEWBOX.maxX, y: VIEWBOX.maxY },
          ],
          label: VIEWBOX_MARKER_LABEL,
          strokeColor: "transparent",
        },
      ],
      texts: [
        ...(graphics.texts ?? []),
        {
          x: DANGLING_ENDPOINT.x,
          y: DANGLING_ENDPOINT.y + 0.8,
          text: "dangling endpoint",
          fontSize: 0.42,
        },
      ],
    },
    { backgroundColor: "white", svgWidth: 1400, svgHeight: 800 },
  );

  await expect(cropSvgToIssue(fullSvg)).toMatchSvgSnapshot(import.meta.path);
}, 300_000);

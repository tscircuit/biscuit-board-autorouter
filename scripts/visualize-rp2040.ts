import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug";
import {
  generateBiscuitBoardHypergraph,
  type BiscuitBoardRoutingSolution,
} from "../lib";
import { netColor } from "../lib/geometry";
import capturedInput from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";

const input = capturedInput as SimpleRouteJson;
const solutionPath = process.argv[2];
const outputPath = process.argv[3] ?? "rp2040-visualization.svg";
if (!solutionPath) {
  throw new Error(
    "Usage: bun scripts/visualize-rp2040.ts <solution.json> [output.svg]",
  );
}

const solution = (await Bun.file(
  solutionPath,
).json()) as BiscuitBoardRoutingSolution;
const prepared = generateBiscuitBoardHypergraph(input, {
  gridClearance: 0.1,
  maxRipsPerRoute: 1_000,
  maxTotalRips: 10_000,
  routeOrder: "signal_longest_first",
});

const rects: NonNullable<GraphicsObject["rects"]> = [];
const lines: NonNullable<GraphicsObject["lines"]> = [];
const circles: NonNullable<GraphicsObject["circles"]> = [];

for (const obstacle of input.obstacles) {
  const isPrefabVia =
    obstacle.netIsAssignable &&
    obstacle.connectedTo.some((id) => id.startsWith("pcb_via"));
  rects.push({
    center: obstacle.center,
    width: obstacle.width,
    height: obstacle.height,
    fill: isPrefabVia ? "#fde68a" : "#e2e8f0",
    stroke: isPrefabVia ? "#d97706" : "#94a3b8",
  });
}

const layerColor = (layer: string, netId: string) =>
  layer === "top" ? netColor(netId) : "#7c3aed";

for (const route of solution.routes ?? []) {
  for (let index = 1; index < route.nodePath.length; index++) {
    const from = prepared.nodes[route.nodePath[index - 1]!]!;
    const to = prepared.nodes[route.nodePath[index]!]!;
    if (from.layer !== to.layer) {
      circles.push({
        center: { x: from.x, y: from.y },
        radius: 0.35,
        fill: "none",
        stroke: "#dc2626",
      });
      continue;
    }
    lines.push({
      points: [
        { x: from.x, y: from.y },
        { x: to.x, y: to.y },
      ],
      strokeColor: layerColor(from.layer, route.netId),
      strokeWidth: from.layer === "top" ? 0.16 : 0.24,
      label: `${route.routeId} (${from.layer})`,
    });
  }
}

const graphics: GraphicsObject = {
  title: `RP2040 solution · ${(solution.routes ?? []).length} routes`,
  rects,
  lines,
  circles,
  coordinateSystem: "cartesian",
};
const svg = getSvgFromGraphicsObject(graphics, { backgroundColor: "white" });
await Bun.write(outputPath, svg);
console.log(
  `Wrote ${outputPath} with ${(solution.routes ?? []).length} routes, ${lines.length} segments`,
);

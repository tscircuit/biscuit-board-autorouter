import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  BiscuitBoardRoutingPipelineSolver,
  generateBiscuitBoardHypergraph,
} from "../lib";
import capturedInput from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";

const input = capturedInput as SimpleRouteJson;

test("preserves the exact BiscuitBoard RP2040 routing reproduction", () => {
  expect(input.connections).toHaveLength(35);
  expect(input.obstacles).toHaveLength(215);
  expect(
    input.obstacles.filter(
      (obstacle) =>
        obstacle.netIsAssignable &&
        obstacle.connectedTo.some((id) => id.startsWith("pcb_via")),
    ),
  ).toHaveLength(54);

  const prepared = generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.1,
    maxRipsPerRoute: 1_000,
    maxTotalRips: 10_000,
  });
  expect(prepared.demands).toHaveLength(97);
  expect(prepared.prefabricatedVias).toHaveLength(54);
  expect(prepared.nodes.length).toBeGreaterThan(50_000);
  expect(prepared.edges.length).toBeGreaterThan(100_000);
  expect(
    prepared.edges.filter((edge) => edge.kind === "fixed_via_transition"),
  ).toHaveLength(54);
}, 30_000);

test("matches the exact BiscuitBoard RP2040 repro02 routing input", async () => {
  const solver = new BiscuitBoardRoutingPipelineSolver(input);
  const svg = getSvgFromGraphicsObject(solver.initialVisualize(), {
    backgroundColor: "white",
    svgWidth: 1200,
    svgHeight: 900,
  });

  await expect(svg).toMatchSvgSnapshot(import.meta.path);
});

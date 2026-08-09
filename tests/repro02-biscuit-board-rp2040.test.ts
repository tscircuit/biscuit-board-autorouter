import "bun-match-svg";
import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { getSvgFromGraphicsObject } from "graphics-debug";
import {
  generateBiscuitBoardHypergraph,
  getTraceClearanceViolations,
  PostProcessBiscuitBoardTracesSolver,
  type BiscuitBoardRoutingSolution,
  type PreparedBiscuitRoutingProblem,
} from "../lib";
import builtFixture from "../repros/fixtures/repro02-biscuit-board-rp2040.built.json";
import capturedInput from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";
import solvedFixture from "../repros/fixtures/repro02-biscuit-board-rp2040.solved.json";

const input = capturedInput as SimpleRouteJson;
const built = builtFixture as BiscuitBoardRoutingSolution;
const solved = solvedFixture as BiscuitBoardRoutingSolution;
let prepared: PreparedBiscuitRoutingProblem | undefined;
const getPrepared = () =>
  (prepared ??= generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.1,
    maxRipsPerRoute: 1_000,
    maxTotalRips: 10_000,
    routeOrder: "signal_longest_first",
  }));

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

  const problem = getPrepared();
  expect(problem.demands).toHaveLength(97);
  expect(problem.prefabricatedVias).toHaveLength(54);
  expect(problem.nodes.length).toBeGreaterThan(50_000);
  expect(problem.edges.length).toBeGreaterThan(100_000);
  expect(
    problem.edges.filter((edge) => edge.kind === "fixed_via_transition"),
  ).toHaveLength(54);
}, 30_000);

test("matches the solved BiscuitBoard RP2040 repro02 SVG", async () => {
  const problem = getPrepared();
  const solver = new PostProcessBiscuitBoardTracesSolver({
    prepared: problem,
    built,
  });
  solver.solve();
  const output = solver.getOutput();

  expect(output).toEqual(solved);
  expect(output?.routes).toHaveLength(97);
  expect(output?.traces).toHaveLength(97);
  expect(
    output?.traces.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    ),
  ).toEqual([]);
  expect(getTraceClearanceViolations(problem, output!)).toEqual([]);

  const svg = getSvgFromGraphicsObject(solver.visualize(), {
    backgroundColor: "white",
    svgWidth: 1200,
    svgHeight: 900,
  });

  await expect(svg).toMatchSvgSnapshot(import.meta.path);
}, 30_000);

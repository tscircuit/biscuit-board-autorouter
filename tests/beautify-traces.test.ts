import { expect, test } from "bun:test";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import {
  beautifyBiscuitBoardTraces,
  type BiscuitBoardRoutingSolution,
  generateBiscuitBoardHypergraph,
  getTraceClearanceViolations,
} from "../lib";

const createSolution = (
  input: SimpleRouteJson,
  routes: Array<Array<{ x: number; y: number }>>,
) => {
  const prepared = generateBiscuitBoardHypergraph(input, {
    gridClearance: 0.2,
  });
  const traces: SimplifiedPcbTrace[] = prepared.demands.map(
    (demand, traceIndex) => ({
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_${traceIndex}`,
      connection_name: demand.connectionName,
      connectsTo: [demand.sourcePointId, demand.targetPointId].filter(
        (pointId): pointId is string => Boolean(pointId),
      ),
      route: routes[traceIndex]!.map((point) => ({
        route_type: "wire" as const,
        ...point,
        layer: "top",
        width: demand.width,
      })),
    }),
  );
  const solution: BiscuitBoardRoutingSolution = {
    routes: prepared.demands.map((demand) => ({
      routeId: demand.routeId,
      connectionName: demand.connectionName,
      netId: demand.netId,
      nodePath: [demand.sourceNode, demand.targetNode],
      edgePath: [],
      blockerRouteIds: [],
    })),
    traces,
    stats: {
      routeCount: traces.length,
      routedCount: traces.length,
      pendingCount: 0,
      ripCount: 0,
      expandedStateCount: 0,
      fixedViaTransitionCount: 0,
      graphNodeCount: prepared.nodes.length,
      graphEdgeCount: prepared.edges.length,
    },
  };
  return { prepared, solution };
};

const getHorizontalSegments = (trace: SimplifiedPcbTrace) =>
  trace.route.slice(1).flatMap((end, index) => {
    const start = trace.route[index]!;
    if (
      start.route_type !== "wire" ||
      end.route_type !== "wire" ||
      start.layer !== end.layer ||
      Math.abs(start.y - end.y) > 1e-7
    ) {
      return [];
    }
    return [
      {
        y: start.y,
        minX: Math.min(start.x, end.x),
        maxX: Math.max(start.x, end.x),
      },
    ];
  });

const getLongestSharedHorizontalRun = (
  first: SimplifiedPcbTrace,
  second: SimplifiedPcbTrace,
) =>
  Math.max(
    0,
    ...getHorizontalSegments(first).flatMap((firstSegment) =>
      getHorizontalSegments(second).map((secondSegment) =>
        Math.abs(firstSegment.y - secondSegment.y) <= 1e-7
          ? Math.max(
              0,
              Math.min(firstSegment.maxX, secondSegment.maxX) -
                Math.max(firstSegment.minX, secondSegment.minX),
            )
          : 0,
      ),
    ),
  );

test("beautification takes the largest available 45-degree corner", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.15,
    obstacles: [],
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: 1, y: 1, layer: "top", pointId: "start" },
          { x: 5, y: 5, layer: "top", pointId: "end" },
        ],
      },
    ],
  };
  const { prepared, solution } = createSolution(input, [
    [
      { x: 1, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 5 },
    ],
  ]);

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);
  const wirePoints = beautified.traces[0]!.route.filter(
    (point) => point.route_type === "wire",
  );
  expect(wirePoints).toHaveLength(2);
  expect(Math.abs(wirePoints[1]!.x - wirePoints[0]!.x)).toBe(
    Math.abs(wirePoints[1]!.y - wirePoints[0]!.y),
  );
  expect(beautified.stats.fortyFiveDegreeChamferCount).toBe(1);
});

test("beautification increases spacing between foreign-net traces", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.2,
    obstacles: [],
    connections: [
      {
        name: "wide-span",
        width: 0.1,
        pointsToConnect: [
          { x: 1, y: 4, layer: "top", pointId: "a-left" },
          { x: 9, y: 4, layer: "top", pointId: "a-right" },
        ],
      },
      {
        name: "short-span",
        width: 0.1,
        pointsToConnect: [
          { x: 2, y: 4.35, layer: "top", pointId: "b-left" },
          { x: 8, y: 4.35, layer: "top", pointId: "b-right" },
        ],
      },
    ],
  };
  const { prepared, solution } = createSolution(input, [
    [
      { x: 1, y: 4 },
      { x: 9, y: 4 },
    ],
    [
      { x: 2, y: 4.35 },
      { x: 8, y: 4.35 },
    ],
  ]);
  expect(getTraceClearanceViolations(prepared, solution, 0.2)).toEqual([]);
  expect(getTraceClearanceViolations(prepared, solution, 0.4)).not.toEqual([]);

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);
  expect(beautified.stats.beautifiedClearance).toBeGreaterThan(0.2);
  expect(
    getTraceClearanceViolations(
      prepared,
      beautified,
      beautified.stats.beautifiedClearance,
    ),
  ).toEqual([]);
});

test("beautification consolidates same-net spans onto shared copper", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layerCount: 1,
    minTraceWidth: 0.1,
    obstacles: [
      {
        type: "rect",
        center: { x: 5, y: 5 },
        width: 2,
        height: 2,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    connections: [
      {
        name: "upper-branch",
        width: 0.1,
        pointsToConnect: [
          { x: 1, y: 5, layer: "top", pointId: "shared-left" },
          { x: 9, y: 5, layer: "top", pointId: "shared-right" },
        ],
      },
      {
        name: "lower-branch",
        width: 0.1,
        pointsToConnect: [
          { x: 1, y: 5, layer: "top", pointId: "shared-left" },
          { x: 9, y: 5, layer: "top", pointId: "shared-right" },
        ],
      },
    ],
  };
  const { prepared, solution } = createSolution(input, [
    [
      { x: 1, y: 5 },
      { x: 3, y: 6.7 },
      { x: 7, y: 6.7 },
      { x: 9, y: 5 },
    ],
    [
      { x: 1, y: 5 },
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 9, y: 5 },
    ],
  ]);

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);
  const geometry = beautified.traces.map((trace) =>
    trace.route.map((point) =>
      point.route_type === "wire" ? [point.x, point.y] : point.route_type,
    ),
  );
  expect(geometry[1]).toEqual(geometry[0]);
  expect(beautified.stats.sameNetConsolidationCount).toBeGreaterThan(0);
});

const createParallelSameNetCase = (
  blocker: "none" | "obstacle" | "foreign-trace",
) => {
  const obstacles: SimpleRouteJson["obstacles"] =
    blocker === "obstacle"
      ? [
          {
            type: "rect",
            center: { x: 5, y: 4 },
            width: 1,
            height: 0.2,
            layers: ["top"],
            connectedTo: [],
          },
        ]
      : [];
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 8 },
    layerCount: 1,
    minTraceWidth: 0.1,
    obstacles,
    connections: [
      {
        name: "outer-ground",
        netConnectionName: "GND",
        pointsToConnect: [
          { x: 1, y: 3, layer: "top", pointId: "outer-left" },
          { x: 9, y: 3, layer: "top", pointId: "outer-right" },
        ],
      },
      {
        name: "inner-ground",
        netConnectionName: "GND",
        pointsToConnect: [
          { x: 2, y: 5, layer: "top", pointId: "inner-left" },
          { x: 8, y: 5, layer: "top", pointId: "inner-right" },
        ],
      },
      ...(blocker === "foreign-trace"
        ? [
            {
              name: "signal",
              pointsToConnect: [
                { x: 3, y: 4, layer: "top", pointId: "signal-left" },
                { x: 7, y: 4, layer: "top", pointId: "signal-right" },
              ],
            },
          ]
        : []),
    ],
  };
  return createSolution(input, [
    [
      { x: 1, y: 3 },
      { x: 9, y: 3 },
    ],
    [
      { x: 2, y: 5 },
      { x: 8, y: 5 },
    ],
    ...(blocker === "foreign-trace"
      ? [
          [
            { x: 3, y: 4 },
            { x: 7, y: 4 },
          ],
        ]
      : []),
  ]);
};

test("beautification combines unobstructed parallel same-net spans", () => {
  const { prepared, solution } = createParallelSameNetCase("none");

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);

  expect(
    getLongestSharedHorizontalRun(beautified.traces[0]!, beautified.traces[1]!),
  ).toBeGreaterThan(3.9);
  expect(beautified.stats.sameNetConsolidationCount).toBeGreaterThan(0);
  for (const [traceIndex, trace] of beautified.traces.entries()) {
    expect(trace.route[0]).toEqual(solution.traces[traceIndex]!.route[0]);
    expect(trace.route.at(-1)).toEqual(
      solution.traces[traceIndex]!.route.at(-1),
    );
  }
});

test("overlapping parallel same-net copper uses 45-degree approaches", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 8 },
    layerCount: 1,
    minTraceWidth: 0.1,
    obstacles: [],
    connections: [
      {
        name: "anchor-ground",
        netConnectionName: "GND",
        pointsToConnect: [
          { x: 2, y: 3, layer: "top", pointId: "anchor-left" },
          { x: 8, y: 3, layer: "top", pointId: "anchor-right" },
        ],
      },
      {
        name: "offset-ground",
        netConnectionName: "GND",
        pointsToConnect: [
          { x: 2, y: 3.05, layer: "top", pointId: "offset-left" },
          { x: 8, y: 3.05, layer: "top", pointId: "offset-right" },
        ],
      },
    ],
  };
  const { prepared, solution } = createSolution(input, [
    [
      { x: 2, y: 3 },
      { x: 8, y: 3 },
    ],
    [
      { x: 2, y: 3.05 },
      { x: 8, y: 3.05 },
    ],
  ]);

  const beautified = beautifyBiscuitBoardTraces(prepared, solution);
  const approachSegments = beautified.traces[0]!.route.slice(1).flatMap(
    (end, index) => {
      const start = beautified.traces[0]!.route[index]!;
      if (
        start.route_type !== "wire" ||
        end.route_type !== "wire" ||
        Math.abs(start.y - end.y) <= 1e-7
      ) {
        return [];
      }
      return [{ start, end }];
    },
  );

  expect(beautified.stats.sameNetConsolidationCount).toBeGreaterThan(0);
  expect(approachSegments.length).toBeGreaterThan(0);
  for (const { start, end } of approachSegments) {
    expect(Math.abs(end.x - start.x)).toBeCloseTo(Math.abs(end.y - start.y), 7);
  }
});

for (const [blocker, blockerLabel] of [
  ["obstacle", "an obstacle"],
  ["foreign-trace", "a foreign trace"],
] as const) {
  test(`beautification leaves parallel same-net spans apart when ${blockerLabel} is between them`, () => {
    const { prepared, solution } = createParallelSameNetCase(blocker);
    const beautified = beautifyBiscuitBoardTraces(prepared, solution);

    expect(
      getLongestSharedHorizontalRun(
        beautified.traces[0]!,
        beautified.traces[1]!,
      ),
    ).toBe(0);
    expect(beautified.stats.sameNetConsolidationCount).toBe(0);
  });
}

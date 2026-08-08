import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import {
  netColor,
  obstacleBounds,
  pointsEqual,
  segmentDistance,
  segmentIntersectsRectInterior,
} from "./geometry";
import type {
  BiscuitBoardRoutingSolution,
  Point,
  PreparedBiscuitRoutingProblem,
  RouteDemand,
  RoutedConnection,
} from "./types";

type RoutePoint = SimplifiedPcbTrace["route"][number];
type WirePoint = Extract<RoutePoint, { route_type: "wire" }>;

interface TraceContext {
  demand: RouteDemand;
  route: RoutedConnection;
  trace: SimplifiedPcbTrace;
}

interface TraceSegment {
  start: WirePoint;
  end: WirePoint;
}

const obstacleHasPcbViaId = (obstacle: SimpleRouteJson["obstacles"][number]) =>
  obstacle.connectedTo.some((id) => id.startsWith("pcb_via"));

const traceTraversesObstacle = (
  trace: SimplifiedPcbTrace,
  obstacle: SimpleRouteJson["obstacles"][number],
) =>
  trace.route.some(
    (point) =>
      point.route_type === "through_obstacle" &&
      pointsEqual(point.start, obstacle.center) &&
      pointsEqual(point.end, obstacle.center),
  );

export interface TraceClearanceViolation {
  kind: "obstacle" | "trace";
  traceId: string;
  otherId: string;
  message: string;
}

const EPSILON = 1e-7;

export const getEffectiveTraceClearance = (
  prepared: PreparedBiscuitRoutingProblem,
) =>
  Math.max(
    prepared.options.gridClearance,
    prepared.input.minTraceToPadEdgeClearance ?? 0,
  );

const getTraceContexts = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
): TraceContext[] => {
  if (solution.routes.length !== solution.traces.length) {
    throw new Error(
      `Expected one trace per routed demand, got ${solution.routes.length} routes and ${solution.traces.length} traces`,
    );
  }
  return solution.routes.map((route, index) => {
    const demand = prepared.demandById.get(route.routeId);
    if (!demand) throw new Error(`Missing demand for route "${route.routeId}"`);
    return { demand, route, trace: solution.traces[index]! };
  });
};

const getSegments = (trace: SimplifiedPcbTrace): TraceSegment[] => {
  const segments: TraceSegment[] = [];
  for (let index = 1; index < trace.route.length; index++) {
    const start = trace.route[index - 1]!;
    const end = trace.route[index]!;
    if (
      start.route_type === "wire" &&
      end.route_type === "wire" &&
      start.layer === end.layer &&
      !pointsEqual(start, end)
    ) {
      segments.push({ start, end });
    }
  }
  return segments;
};

const obstacleAllowsSegment = (
  prepared: PreparedBiscuitRoutingProblem,
  context: TraceContext,
  obstacleIndex: number,
  segment: TraceSegment,
) => {
  const obstacle = prepared.input.obstacles[obstacleIndex]!;
  const identifiers = [
    context.demand.connectionName,
    context.demand.netId,
    context.demand.sourcePointId,
    context.demand.targetPointId,
  ].filter((identifier): identifier is string => Boolean(identifier));
  if (
    identifiers.some((identifier) => obstacle.connectedTo.includes(identifier))
  ) {
    return true;
  }
  return (
    obstacle.netIsAssignable === true &&
    obstacleHasPcbViaId(obstacle) &&
    traceTraversesObstacle(context.trace, obstacle) &&
    (pointsEqual(segment.start, obstacle.center) ||
      pointsEqual(segment.end, obstacle.center))
  );
};

export const getTraceClearanceViolations = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  clearance = getEffectiveTraceClearance(prepared),
): TraceClearanceViolation[] => {
  const contexts = getTraceContexts(prepared, solution);
  const segmentsByTrace = contexts.map((context) => getSegments(context.trace));
  const violations: TraceClearanceViolation[] = [];

  for (const [contextIndex, context] of contexts.entries()) {
    for (const segment of segmentsByTrace[contextIndex]!) {
      for (const [
        obstacleIndex,
        obstacle,
      ] of prepared.input.obstacles.entries()) {
        if (
          obstacle.isCopperPour ||
          !obstacle.layers.includes(segment.start.layer) ||
          obstacleAllowsSegment(prepared, context, obstacleIndex, segment)
        ) {
          continue;
        }
        const expanded = obstacleBounds(
          obstacle,
          segment.start.width / 2 + clearance,
        );
        if (
          segmentIntersectsRectInterior(segment.start, segment.end, expanded)
        ) {
          violations.push({
            kind: "obstacle",
            traceId: context.trace.pcb_trace_id,
            otherId:
              obstacle.obstacleId ??
              obstacle.componentId ??
              `obstacle-${obstacleIndex}`,
            message: `Trace "${context.route.routeId}" is within ${clearance}mm of obstacle ${obstacleIndex}`,
          });
        }
      }
    }
  }

  for (let firstIndex = 0; firstIndex < contexts.length; firstIndex++) {
    const first = contexts[firstIndex]!;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < contexts.length;
      secondIndex++
    ) {
      const second = contexts[secondIndex]!;
      if (first.demand.netId === second.demand.netId) continue;
      for (const firstSegment of segmentsByTrace[firstIndex]!) {
        for (const secondSegment of segmentsByTrace[secondIndex]!) {
          if (firstSegment.start.layer !== secondSegment.start.layer) continue;
          const minimumCenterDistance =
            firstSegment.start.width / 2 +
            secondSegment.start.width / 2 +
            clearance;
          if (
            segmentDistance(
              firstSegment.start,
              firstSegment.end,
              secondSegment.start,
              secondSegment.end,
            ) <
            minimumCenterDistance - EPSILON
          ) {
            violations.push({
              kind: "trace",
              traceId: first.trace.pcb_trace_id,
              otherId: second.trace.pcb_trace_id,
              message: `Traces "${first.route.routeId}" and "${second.route.routeId}" are closer than ${clearance}mm`,
            });
          }
        }
      }
    }
  }

  return violations;
};

const createSegmentClearanceChecker = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  traceIndex: number,
  clearance: number,
) => {
  const contexts = getTraceContexts(prepared, solution);
  const context = contexts[traceIndex]!;
  const blockingTraceSegments = contexts.flatMap((other, otherIndex) =>
    otherIndex === traceIndex || other.demand.netId === context.demand.netId
      ? []
      : getSegments(other.trace),
  );

  return (segment: TraceSegment) => {
    for (const [
      obstacleIndex,
      obstacle,
    ] of prepared.input.obstacles.entries()) {
      if (
        obstacle.isCopperPour ||
        !obstacle.layers.includes(segment.start.layer) ||
        obstacleAllowsSegment(prepared, context, obstacleIndex, segment)
      ) {
        continue;
      }
      if (
        segmentIntersectsRectInterior(
          segment.start,
          segment.end,
          obstacleBounds(obstacle, segment.start.width / 2 + clearance),
        )
      ) {
        return false;
      }
    }
    for (const otherSegment of blockingTraceSegments) {
      if (otherSegment.start.layer !== segment.start.layer) continue;
      const minimumCenterDistance =
        segment.start.width / 2 + otherSegment.start.width / 2 + clearance;
      if (
        segmentDistance(
          segment.start,
          segment.end,
          otherSegment.start,
          otherSegment.end,
        ) <
        minimumCenterDistance - EPSILON
      ) {
        return false;
      }
    }
    return true;
  };
};

// Adapted from tscircuit-autorouter's calculate45DegreePaths utility. Each
// candidate contains at most one bend and uses only 0, 45, or 90 degree axes.
const calculate45DegreePaths = (start: Point, end: Point): Point[][] => {
  const paths: Point[][] = [
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
  ];
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  const signX = end.x > start.x ? 1 : -1;
  const signY = end.y > start.y ? 1 : -1;
  const horizontalThenDiagonal = {
    x: end.x - signX * dy,
    y: start.y,
  };
  if (
    (horizontalThenDiagonal.x - start.x) * signX >= 0 &&
    (horizontalThenDiagonal.x - end.x) * signX <= 0
  ) {
    paths.push([start, horizontalThenDiagonal, end]);
  }
  const verticalThenDiagonal = {
    x: start.x,
    y: end.y - signY * dx,
  };
  if (
    (verticalThenDiagonal.y - start.y) * signY >= 0 &&
    (verticalThenDiagonal.y - end.y) * signY <= 0
  ) {
    paths.push([start, verticalThenDiagonal, end]);
  }
  const diagonalThenAxis = {
    x: start.x + signX * Math.min(dx, dy),
    y: start.y + signY * Math.min(dx, dy),
  };
  paths.push([start, diagonalThenAxis, end]);
  return paths;
};

const toWirePath = (path: Point[], template: WirePoint): WirePoint[] => {
  const result: WirePoint[] = [];
  for (const point of path) {
    const wirePoint = { ...template, x: point.x, y: point.y };
    if (!result.some((existing) => pointsEqual(existing, wirePoint))) {
      result.push(wirePoint);
    }
  }
  return result;
};

const collapseCollinearWirePoints = (points: WirePoint[]): WirePoint[] => {
  if (points.length <= 2) return points;
  const result = [points[0]!];
  for (let index = 1; index < points.length - 1; index++) {
    const previous = result[result.length - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const incoming = {
      x: current.x - previous.x,
      y: current.y - previous.y,
    };
    const outgoing = { x: next.x - current.x, y: next.y - current.y };
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    if (Math.abs(cross) <= EPSILON && dot >= 0) continue;
    result.push(current);
  }
  result.push(points[points.length - 1]!);
  return result;
};

const simplifyWireRun = (
  run: WirePoint[],
  segmentHasClearance: (segment: TraceSegment) => boolean,
): WirePoint[] => {
  if (run.length <= 2) return run;
  const simplified: WirePoint[] = [run[0]!];
  let tailIndex = 0;

  while (tailIndex < run.length - 1) {
    let acceptedPath: WirePoint[] | null = null;
    let acceptedHeadIndex = -1;
    for (let headIndex = run.length - 1; headIndex > tailIndex; headIndex--) {
      const start = run[tailIndex]!;
      const end = run[headIndex]!;
      for (const pointPath of calculate45DegreePaths(start, end)) {
        const wirePath = toWirePath(pointPath, start);
        if (
          wirePath.length >= 2 &&
          wirePath.slice(1).every((point, index) =>
            segmentHasClearance({
              start: wirePath[index]!,
              end: point,
            }),
          )
        ) {
          acceptedPath = wirePath;
          acceptedHeadIndex = headIndex;
          break;
        }
      }
      if (acceptedPath) break;
    }
    if (!acceptedPath || acceptedHeadIndex <= tailIndex) {
      throw new Error(
        `Trace simplification could not preserve the validated segment after point ${tailIndex}`,
      );
    }
    simplified.push(...acceptedPath.slice(1));
    tailIndex = acceptedHeadIndex;
  }

  return collapseCollinearWirePoints(simplified);
};

const simplifyTraceRoute = (
  route: SimplifiedPcbTrace["route"],
  segmentHasClearance: (segment: TraceSegment) => boolean,
): SimplifiedPcbTrace["route"] => {
  const simplified: SimplifiedPcbTrace["route"] = [];
  let pointIndex = 0;
  while (pointIndex < route.length) {
    const point = route[pointIndex]!;
    if (point.route_type !== "wire") {
      simplified.push(point);
      pointIndex++;
      continue;
    }
    const run: WirePoint[] = [point];
    let runEndIndex = pointIndex + 1;
    while (runEndIndex < route.length) {
      const next = route[runEndIndex]!;
      if (next.route_type !== "wire" || next.layer !== point.layer) break;
      run.push(next);
      runEndIndex++;
    }
    simplified.push(...simplifyWireRun(run, segmentHasClearance));
    pointIndex = runEndIndex;
  }
  return simplified;
};

const cloneTraces = (traces: SimplifiedPcbTrace[]) =>
  traces.map((trace) => ({
    ...trace,
    route: trace.route.map((point) => ({ ...point })),
  }));

export const postProcessBiscuitBoardTraces = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
): BiscuitBoardRoutingSolution => {
  const clearance = getEffectiveTraceClearance(prepared);
  const initialViolations = getTraceClearanceViolations(
    prepared,
    solution,
    clearance,
  );
  if (initialViolations.length > 0) {
    throw new Error(
      `Cannot post-process traces with existing clearance violations: ${initialViolations[0]!.message}`,
    );
  }

  const traces = cloneTraces(solution.traces);
  const preSimplificationSegmentCount = traces.reduce(
    (count, trace) => count + getSegments(trace).length,
    0,
  );
  for (let pass = 0; pass < 3; pass++) {
    const segmentCountBeforePass = traces.reduce(
      (count, trace) => count + getSegments(trace).length,
      0,
    );
    const traceIndexes = traces
      .map((trace, traceIndex) => ({
        traceIndex,
        segmentCount: getSegments(trace).length,
      }))
      .sort(
        (left, right) =>
          right.segmentCount - left.segmentCount ||
          left.traceIndex - right.traceIndex,
      )
      .map(({ traceIndex }) => traceIndex);
    for (const traceIndex of traceIndexes) {
      const segmentHasClearance = createSegmentClearanceChecker(
        prepared,
        { ...solution, traces },
        traceIndex,
        clearance,
      );
      traces[traceIndex] = {
        ...traces[traceIndex]!,
        route: simplifyTraceRoute(
          traces[traceIndex]!.route,
          segmentHasClearance,
        ),
      };
    }
    const segmentCountAfterPass = traces.reduce(
      (count, trace) => count + getSegments(trace).length,
      0,
    );
    if (segmentCountAfterPass >= segmentCountBeforePass) break;
  }
  const postSimplificationSegmentCount = traces.reduce(
    (count, trace) => count + getSegments(trace).length,
    0,
  );

  const output: BiscuitBoardRoutingSolution = {
    ...solution,
    traces,
    stats: {
      ...solution.stats,
      postProcessedClearance: clearance,
      preSimplificationSegmentCount,
      postSimplificationSegmentCount,
    },
  };
  const finalViolations = getTraceClearanceViolations(
    prepared,
    output,
    clearance,
  );
  if (finalViolations.length > 0) {
    throw new Error(`Trace cleanup failed: ${finalViolations[0]!.message}`);
  }
  return output;
};

const visualizeTraces = (
  prepared: PreparedBiscuitRoutingProblem,
  built: BiscuitBoardRoutingSolution,
  solution: BiscuitBoardRoutingSolution,
): GraphicsObject => {
  const clearance = getEffectiveTraceClearance(prepared);
  const maximumTraceRadius =
    Math.max(
      ...solution.traces
        .flatMap((trace) => getSegments(trace))
        .map((segment) => segment.start.width),
      prepared.input.minTraceWidth,
    ) / 2;
  const rects: NonNullable<GraphicsObject["rects"]> = [];
  const circles: NonNullable<GraphicsObject["circles"]> = [];
  for (const [obstacleIndex, obstacle] of prepared.input.obstacles.entries()) {
    if (obstacle.isCopperPour) continue;
    const identifier =
      obstacle.connectedTo.find((id) => id.startsWith("pcb_smtpad")) ??
      obstacle.connectedTo.find((id) => id.startsWith("pcb_via")) ??
      obstacle.componentId ??
      obstacle.obstacleId ??
      `obstacle-${obstacleIndex}`;
    const isPrefabricatedVia =
      obstacle.netIsAssignable && obstacleHasPcbViaId(obstacle);
    const label = isPrefabricatedVia
      ? `prefabricated via · ${identifier}`
      : `pad/obstacle · ${identifier}`;
    const envelope = obstacleBounds(obstacle, maximumTraceRadius + clearance);
    rects.push({
      center: {
        x: (envelope.minX + envelope.maxX) / 2,
        y: (envelope.minY + envelope.maxY) / 2,
      },
      width: envelope.maxX - envelope.minX,
      height: envelope.maxY - envelope.minY,
      fill: isPrefabricatedVia
        ? "rgba(14,165,233,0.06)"
        : "rgba(239,68,68,0.045)",
      stroke: isPrefabricatedVia
        ? "rgba(2,132,199,0.24)"
        : "rgba(220,38,38,0.16)",
      label: `${label} · ${clearance}mm clearance envelope`,
    });
    if (obstacle.shape === "circle") {
      circles.push({
        center: obstacle.center,
        radius: Math.max(obstacle.width, obstacle.height) / 2,
        fill: isPrefabricatedVia
          ? "rgba(14,165,233,0.42)"
          : "rgba(168,85,247,0.35)",
        stroke: isPrefabricatedVia ? "#0284c7" : "#7e22ce",
        label,
      });
    } else {
      rects.push({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
        fill: obstacle.layers.includes("top")
          ? "rgba(249,115,22,0.30)"
          : "rgba(79,70,229,0.26)",
        stroke: obstacle.layers.includes("top") ? "#c2410c" : "#4338ca",
        label,
      });
    }
  }

  const originalLines = built.traces.flatMap((trace) =>
    getSegments(trace).map((segment) => ({
      points: [segment.start, segment.end],
      strokeColor: "rgba(100,116,139,0.30)",
      strokeWidth: Math.min(segment.start.width, 0.07),
      strokeDash: [0.12, 0.08],
      label: "original unsimplified trace",
    })),
  );
  const simplifiedLines = solution.routes.flatMap((route, index) => {
    const color = netColor(route.netId);
    return getSegments(solution.traces[index]!).map((segment) => ({
      points: [segment.start, segment.end],
      strokeColor: color,
      strokeWidth: segment.start.width,
      zIndex: 2,
      label: `simplified trace · ${route.netId}`,
    }));
  });
  return {
    coordinateSystem: "cartesian",
    title: `Clearance-safe trace simplification (${solution.stats.preSimplificationSegmentCount ?? 0} → ${solution.stats.postSimplificationSegmentCount ?? 0} segments, ${clearance}mm clearance)`,
    rects,
    circles,
    lines: [...originalLines, ...simplifiedLines],
    points: solution.traces.flatMap((trace) =>
      trace.route.flatMap((point) =>
        point.route_type === "through_obstacle"
          ? [
              {
                x: point.start.x,
                y: point.start.y,
                color: "#0369a1",
                label: "used prefabricated via",
              },
            ]
          : [],
      ),
    ),
  };
};

export class PostProcessBiscuitBoardTracesSolver extends BaseSolver {
  private output?: BiscuitBoardRoutingSolution;

  constructor(
    public readonly params: {
      prepared: PreparedBiscuitRoutingProblem;
      built: BiscuitBoardRoutingSolution;
    },
  ) {
    super();
  }

  override getConstructorParams(): [typeof this.params] {
    return [this.params];
  }

  override _step() {
    this.output = postProcessBiscuitBoardTraces(
      this.params.prepared,
      this.params.built,
    );
    this.stats = this.output.stats;
    this.progress = 1;
    this.solved = true;
  }

  override getOutput() {
    return this.output ?? null;
  }

  override visualize(): GraphicsObject {
    return visualizeTraces(
      this.params.prepared,
      this.params.built,
      this.output ?? this.params.built,
    );
  }
}

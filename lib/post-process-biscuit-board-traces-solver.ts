import type { SimplifiedPcbTrace } from "@tscircuit/core";
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
    segmentDistance(
      segment.start,
      segment.end,
      obstacle.center,
      obstacle.center,
    ) <= EPSILON
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

const segmentHasClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  traceIndex: number,
  segment: TraceSegment,
  clearance: number,
) => {
  const contexts = getTraceContexts(prepared, solution);
  const context = contexts[traceIndex]!;
  for (const [obstacleIndex, obstacle] of prepared.input.obstacles.entries()) {
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
  for (const [otherIndex, other] of contexts.entries()) {
    if (
      otherIndex === traceIndex ||
      other.demand.netId === context.demand.netId
    ) {
      continue;
    }
    for (const otherSegment of getSegments(other.trace)) {
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
  }
  return true;
};

const getChamferPoints = (
  previous: WirePoint,
  corner: WirePoint,
  next: WirePoint,
  maximumDistance: number,
): [WirePoint, WirePoint] | null => {
  if (
    previous.layer !== corner.layer ||
    corner.layer !== next.layer ||
    maximumDistance <= 0
  ) {
    return null;
  }
  const incoming = { x: corner.x - previous.x, y: corner.y - previous.y };
  const outgoing = { x: next.x - corner.x, y: next.y - corner.y };
  const incomingLength = Math.hypot(incoming.x, incoming.y);
  const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
  const incomingIsAxisAligned =
    Math.abs(incoming.x) <= EPSILON || Math.abs(incoming.y) <= EPSILON;
  const outgoingIsAxisAligned =
    Math.abs(outgoing.x) <= EPSILON || Math.abs(outgoing.y) <= EPSILON;
  const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
  if (
    incomingLength <= EPSILON ||
    outgoingLength <= EPSILON ||
    !incomingIsAxisAligned ||
    !outgoingIsAxisAligned ||
    Math.abs(dot) > EPSILON
  ) {
    return null;
  }
  const distance = Math.min(
    maximumDistance,
    incomingLength / 2,
    outgoingLength / 2,
  );
  if (distance <= EPSILON) return null;
  return [
    {
      ...corner,
      x: corner.x - (incoming.x / incomingLength) * distance,
      y: corner.y - (incoming.y / incomingLength) * distance,
    },
    {
      ...corner,
      x: corner.x + (outgoing.x / outgoingLength) * distance,
      y: corner.y + (outgoing.y / outgoingLength) * distance,
    },
  ];
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
  let chamferedCornerCount = 0;
  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    let route = traces[traceIndex]!.route;
    let pointIndex = 1;
    while (pointIndex < route.length - 1) {
      const previous = route[pointIndex - 1]!;
      const corner = route[pointIndex]!;
      const next = route[pointIndex + 1]!;
      if (
        previous.route_type !== "wire" ||
        corner.route_type !== "wire" ||
        next.route_type !== "wire"
      ) {
        pointIndex++;
        continue;
      }
      const chamfer = getChamferPoints(
        previous,
        corner,
        next,
        prepared.options.chamferDistance,
      );
      if (!chamfer) {
        pointIndex++;
        continue;
      }
      const candidateRoute = [
        ...route.slice(0, pointIndex),
        ...chamfer,
        ...route.slice(pointIndex + 1),
      ];
      const candidateTraces = traces.map((trace, index) =>
        index === traceIndex ? { ...trace, route: candidateRoute } : trace,
      );
      const candidateSolution = { ...solution, traces: candidateTraces };
      if (
        segmentHasClearance(
          prepared,
          candidateSolution,
          traceIndex,
          { start: chamfer[0], end: chamfer[1] },
          clearance,
        )
      ) {
        traces[traceIndex] = { ...traces[traceIndex]!, route: candidateRoute };
        route = candidateRoute;
        chamferedCornerCount++;
        pointIndex += 2;
      } else {
        pointIndex++;
      }
    }
  }

  const output: BiscuitBoardRoutingSolution = {
    ...solution,
    traces,
    stats: {
      ...solution.stats,
      postProcessedClearance: clearance,
      chamferedCornerCount,
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
  solution: BiscuitBoardRoutingSolution,
): GraphicsObject => ({
  title: `Clearance-safe trace cleanup (${solution.stats.chamferedCornerCount ?? 0} chamfered corners)`,
  lines: solution.routes.flatMap((route, index) => {
    const color = netColor(route.netId);
    return getSegments(solution.traces[index]!).map((segment) => ({
      points: [segment.start, segment.end],
      strokeColor: color,
      strokeWidth: segment.start.width,
    }));
  }),
  points: solution.traces.flatMap((trace) =>
    trace.route.flatMap((point) =>
      point.route_type === "via"
        ? [{ x: point.x, y: point.y, color: "#0284c7", label: "fixed via" }]
        : [],
    ),
  ),
});

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
    return visualizeTraces(this.output ?? this.params.built);
  }
}

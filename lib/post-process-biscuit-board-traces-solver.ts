import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import { ConnectionNameResolver } from "@tscircuit/power-trace-expander";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { BuildBiscuitBoardTracesSolver } from "./build-biscuit-board-traces-solver";
import {
  netColor,
  obstacleBounds,
  pointsEqual,
  segmentDistance,
  segmentIntersectsRectInterior,
} from "./geometry";
import { RipUpRubberBandSolver } from "./rip-up-rubber-band-solver";
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
  obstacleIndex?: number;
}

const EPSILON = 1e-7;
const junctionKey = (point: { x: number; y: number; layer: string }) =>
  `${point.layer}:${point.x.toFixed(6)}:${point.y.toFixed(6)}`;

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
  connectionNameResolver: ConnectionNameResolver,
  allowAllSameNetCopper = false,
) => {
  const obstacle = prepared.input.obstacles[obstacleIndex]!;
  const prefabViaId = obstacle.connectedTo.find((identifier) =>
    identifier.startsWith("pcb_via"),
  );
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
  if (allowAllSameNetCopper) {
    const canonicalIdentifiers = new Set(
      connectionNameResolver.canonicalize([
        ...identifiers,
        ...(context.demand.allowedConnectionNames ?? []),
        context.trace.connection_name ?? "",
        ...(context.trace.connectsTo ?? []),
      ]),
    );
    if (
      connectionNameResolver
        .canonicalize(obstacle.connectedTo)
        .some((identifier) => canonicalIdentifiers.has(identifier))
    ) {
      return true;
    }
  }
  return (
    obstacle.netIsAssignable === true &&
    Boolean(prefabViaId) &&
    (traceTraversesObstacle(context.trace, obstacle) ||
      context.trace.connectsTo?.includes(prefabViaId!)) &&
    (pointsEqual(segment.start, obstacle.center) ||
      pointsEqual(segment.end, obstacle.center))
  );
};

export const getTraceClearanceViolations = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  clearance = getEffectiveTraceClearance(prepared),
  respectObstacleRotation = true,
): TraceClearanceViolation[] => {
  const contexts = getTraceContexts(prepared, solution);
  const connectionNameResolver = new ConnectionNameResolver(
    prepared.input,
    solution.traces,
  );
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
          obstacleAllowsSegment(
            prepared,
            context,
            obstacleIndex,
            segment,
            connectionNameResolver,
            true,
          )
        ) {
          continue;
        }
        const expanded = obstacleBounds(
          obstacle,
          segment.start.width / 2 + clearance,
          respectObstacleRotation,
        );
        if (
          segmentIntersectsRectInterior(segment.start, segment.end, expanded)
        ) {
          violations.push({
            kind: "obstacle",
            traceId: context.trace.pcb_trace_id,
            obstacleIndex,
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
  respectObstacleRotation = true,
) => {
  const contexts = getTraceContexts(prepared, solution);
  const connectionNameResolver = new ConnectionNameResolver(
    prepared.input,
    solution.traces,
  );
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
        obstacleAllowsSegment(
          prepared,
          context,
          obstacleIndex,
          segment,
          connectionNameResolver,
        )
      ) {
        continue;
      }
      if (
        segmentIntersectsRectInterior(
          segment.start,
          segment.end,
          obstacleBounds(
            obstacle,
            segment.start.width / 2 + clearance,
            respectObstacleRotation,
          ),
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

/**
 * Checks a replacement route against every foreign-net trace and obstacle.
 * The trace being replaced is intentionally omitted from the comparison so
 * post-processing stages can evaluate candidates without mutating a solution.
 */
export const traceRouteHasClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  traceIndex: number,
  route: SimplifiedPcbTrace["route"],
  clearance = getEffectiveTraceClearance(prepared),
) => {
  const segmentHasClearance = createSegmentClearanceChecker(
    prepared,
    solution,
    traceIndex,
    clearance,
  );
  return getSegments({ ...solution.traces[traceIndex]!, route }).every(
    segmentHasClearance,
  );
};

export const traceSegmentsHaveClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  traceIndex: number,
  segments: Array<{ start: WirePoint; end: WirePoint }>,
  clearance = getEffectiveTraceClearance(prepared),
) => {
  const segmentHasClearance = createSegmentClearanceChecker(
    prepared,
    solution,
    traceIndex,
    clearance,
  );
  return segments.every(segmentHasClearance);
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
  protectedJunctionKeys: ReadonlySet<string>,
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
    if (run.length === 1) {
      simplified.push(run[0]!);
      pointIndex = runEndIndex;
      continue;
    }
    let chunkStartIndex = 0;
    for (let index = 1; index < run.length; index++) {
      const isProtectedJunction = protectedJunctionKeys.has(
        junctionKey(run[index]!),
      );
      if (index < run.length - 1 && !isProtectedJunction) continue;
      const simplifiedChunk = simplifyWireRun(
        run.slice(chunkStartIndex, index + 1),
        segmentHasClearance,
      );
      const previous = simplified.at(-1);
      simplified.push(
        ...(previous?.route_type === "wire" &&
        pointsEqual(previous, simplifiedChunk[0]!) &&
        previous.layer === simplifiedChunk[0]!.layer
          ? simplifiedChunk.slice(1)
          : simplifiedChunk),
      );
      chunkStartIndex = index;
    }
    pointIndex = runEndIndex;
  }
  return simplified;
};

const cloneTraces = (traces: SimplifiedPcbTrace[]) =>
  traces.map((trace) => ({
    ...trace,
    route: trace.route.map((point) => ({ ...point })),
  }));

const wirePathLength = (path: WirePoint[]) =>
  path
    .slice(1)
    .reduce(
      (total, point, index) =>
        total + Math.hypot(point.x - path[index]!.x, point.y - path[index]!.y),
      0,
    );

class RotatedObstacleRepairError extends Error {
  constructor(
    readonly routeId: string,
    readonly obstacleIndex: number,
  ) {
    super(
      `Could not detour trace "${routeId}" around rotated obstacle ${obstacleIndex}`,
    );
  }
}

const repairRotatedObstacleClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  clearance: number,
  fallbackTraces: SimplifiedPcbTrace[] = [],
) => {
  const traces = cloneTraces(solution.traces);
  const connectionNameResolver = new ConnectionNameResolver(
    prepared.input,
    solution.traces,
  );
  const restoredTraceIndexes = new Set<number>();
  const maximumRepairs = Math.max(
    traces.reduce((count, trace) => count + getSegments(trace).length, 0),
    fallbackTraces.reduce(
      (count, trace) => count + getSegments(trace).length,
      0,
    ),
  );

  for (let repairCount = 0; repairCount < maximumRepairs; repairCount++) {
    let repaired = false;
    const workingSolution = { ...solution, traces };
    const contexts = getTraceContexts(prepared, workingSolution);

    for (const [traceIndex, context] of contexts.entries()) {
      const route = [...context.trace.route];
      const segmentHasClearance = createSegmentClearanceChecker(
        prepared,
        workingSolution,
        traceIndex,
        clearance,
      );

      for (let pointIndex = 1; pointIndex < route.length; pointIndex++) {
        const start = route[pointIndex - 1]!;
        const end = route[pointIndex]!;
        if (
          start.route_type !== "wire" ||
          end.route_type !== "wire" ||
          start.layer !== end.layer ||
          pointsEqual(start, end)
        ) {
          continue;
        }
        const segment = { start, end };
        const blockingEntry = [...prepared.input.obstacles.entries()].find(
          ([obstacleIndex, obstacle]) =>
            Math.abs(obstacle.ccwRotationDegrees ?? 0) > EPSILON &&
            !obstacle.isCopperPour &&
            obstacle.layers.includes(start.layer) &&
            !obstacleAllowsSegment(
              prepared,
              context,
              obstacleIndex,
              segment,
              connectionNameResolver,
            ) &&
            segmentIntersectsRectInterior(
              start,
              end,
              obstacleBounds(obstacle, start.width / 2 + clearance),
            ),
        );
        if (!blockingEntry) continue;

        const [blockingObstacleIndex, obstacle] = blockingEntry;
        const bounds = obstacleBounds(obstacle, start.width / 2 + clearance);
        const nudge = 1e-4;
        const detourStep = Math.max(clearance, start.width / 2, 0.05);
        const maximumDetourDistance = Math.max(
          prepared.options.gridPitch * 4,
          2,
        );
        const detourOffsets = Array.from(
          { length: Math.ceil(maximumDetourDistance / detourStep) + 1 },
          (_, index) => nudge + index * detourStep,
        );
        const createCandidatePointPaths = (
          candidateStart: WirePoint,
          candidateEnd: WirePoint,
        ): Point[][] =>
          detourOffsets.flatMap((offset) => {
            const left = bounds.minX - offset;
            const right = bounds.maxX + offset;
            const bottom = bounds.minY - offset;
            const top = bounds.maxY + offset;
            const firstX = candidateStart.x <= candidateEnd.x ? left : right;
            const secondX = candidateStart.x <= candidateEnd.x ? right : left;
            const firstY = candidateStart.y <= candidateEnd.y ? bottom : top;
            const secondY = candidateStart.y <= candidateEnd.y ? top : bottom;
            return [
              [
                candidateStart,
                { x: left, y: candidateStart.y },
                { x: left, y: candidateEnd.y },
                candidateEnd,
              ],
              [
                candidateStart,
                { x: right, y: candidateStart.y },
                { x: right, y: candidateEnd.y },
                candidateEnd,
              ],
              [
                candidateStart,
                { x: candidateStart.x, y: bottom },
                { x: candidateEnd.x, y: bottom },
                candidateEnd,
              ],
              [
                candidateStart,
                { x: candidateStart.x, y: top },
                { x: candidateEnd.x, y: top },
                candidateEnd,
              ],
              [
                candidateStart,
                { x: firstX, y: candidateStart.y },
                { x: firstX, y: bottom },
                { x: secondX, y: bottom },
                { x: secondX, y: candidateEnd.y },
                candidateEnd,
              ],
              [
                candidateStart,
                { x: firstX, y: candidateStart.y },
                { x: firstX, y: top },
                { x: secondX, y: top },
                { x: secondX, y: candidateEnd.y },
                candidateEnd,
              ],
              [
                candidateStart,
                { x: candidateStart.x, y: firstY },
                { x: left, y: firstY },
                { x: left, y: secondY },
                { x: candidateEnd.x, y: secondY },
                candidateEnd,
              ],
              [
                candidateStart,
                { x: candidateStart.x, y: firstY },
                { x: right, y: firstY },
                { x: right, y: secondY },
                { x: candidateEnd.x, y: secondY },
                candidateEnd,
              ],
            ];
          });
        const boardMargin =
          (prepared.input.minBoardEdgeClearance ?? 0) + start.width / 2;
        const getValidDetours = (
          candidateStart: WirePoint,
          candidateEnd: WirePoint,
        ) =>
          createCandidatePointPaths(candidateStart, candidateEnd)
            .filter((path) =>
              path
                .slice(1, -1)
                .every(
                  (point) =>
                    point.x >= prepared.input.bounds.minX + boardMargin &&
                    point.x <= prepared.input.bounds.maxX - boardMargin &&
                    point.y >= prepared.input.bounds.minY + boardMargin &&
                    point.y <= prepared.input.bounds.maxY - boardMargin,
                ),
            )
            .map((path) =>
              collapseCollinearWirePoints(toWirePath(path, candidateStart)),
            )
            .filter((path) =>
              path
                .slice(1)
                .every((point, index) =>
                  segmentHasClearance({ start: path[index]!, end: point }),
                ),
            )
            .sort(
              (left, right) =>
                wirePathLength(left) - wirePathLength(right) ||
                left.length - right.length,
            );

        let detour = getValidDetours(start, end)[0];
        let detourStartIndex = pointIndex - 1;
        let detourEndIndex = pointIndex;
        if (!detour) {
          for (let spanSize = 1; spanSize <= 8 && !detour; spanSize++) {
            for (let before = 0; before <= spanSize; before++) {
              const after = spanSize - before;
              const startIndex = pointIndex - 1 - before;
              const endIndex = pointIndex + after;
              if (startIndex < 0 || endIndex >= route.length) continue;
              const span = route.slice(startIndex, endIndex + 1);
              if (
                !span.every(
                  (point) =>
                    point.route_type === "wire" && point.layer === start.layer,
                )
              ) {
                continue;
              }
              const spanStart = span[0] as WirePoint;
              const spanEnd = span.at(-1) as WirePoint;
              detour = getValidDetours(spanStart, spanEnd)[0];
              if (detour) {
                detourStartIndex = startIndex;
                detourEndIndex = endIndex;
                break;
              }
            }
          }
        }
        if (!detour) {
          const fallbackTrace = fallbackTraces[traceIndex];
          if (fallbackTrace && !restoredTraceIndexes.has(traceIndex)) {
            traces[traceIndex] = {
              ...fallbackTrace,
              route: fallbackTrace.route.map((point) => ({ ...point })),
            };
            restoredTraceIndexes.add(traceIndex);
            repaired = true;
            break;
          }
          throw new RotatedObstacleRepairError(
            context.route.routeId,
            blockingObstacleIndex,
          );
        }
        route.splice(
          detourStartIndex,
          detourEndIndex - detourStartIndex + 1,
          ...detour,
        );
        traces[traceIndex] = { ...context.trace, route };
        repaired = true;
        break;
      }
      if (repaired) break;
    }

    if (!repaired) return traces;
  }

  throw new Error("Rotated-obstacle trace repair exceeded its iteration limit");
};

const repairTraceClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  clearance: number,
) => {
  const traces = cloneTraces(solution.traces);
  const maximumRepairs = traces.reduce(
    (count, trace) => count + getSegments(trace).length,
    0,
  );

  for (let repairCount = 0; repairCount < maximumRepairs; repairCount++) {
    const workingSolution = { ...solution, traces };
    const contexts = getTraceContexts(prepared, workingSolution);
    let repaired = false;

    for (let firstIndex = 0; firstIndex < contexts.length; firstIndex++) {
      const first = contexts[firstIndex]!;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < contexts.length;
        secondIndex++
      ) {
        const second = contexts[secondIndex]!;
        if (first.demand.netId === second.demand.netId) continue;

        for (
          let firstPointIndex = 1;
          firstPointIndex < first.trace.route.length;
          firstPointIndex++
        ) {
          const firstStart = first.trace.route[firstPointIndex - 1]!;
          const firstEnd = first.trace.route[firstPointIndex]!;
          if (
            firstStart.route_type !== "wire" ||
            firstEnd.route_type !== "wire" ||
            firstStart.layer !== firstEnd.layer ||
            pointsEqual(firstStart, firstEnd)
          ) {
            continue;
          }

          for (
            let secondPointIndex = 1;
            secondPointIndex < second.trace.route.length;
            secondPointIndex++
          ) {
            const secondStart = second.trace.route[secondPointIndex - 1]!;
            const secondEnd = second.trace.route[secondPointIndex]!;
            if (
              secondStart.route_type !== "wire" ||
              secondEnd.route_type !== "wire" ||
              secondStart.layer !== secondEnd.layer ||
              firstStart.layer !== secondStart.layer ||
              pointsEqual(secondStart, secondEnd)
            ) {
              continue;
            }
            const minimumCenterDistance =
              firstStart.width / 2 + secondStart.width / 2 + clearance;
            if (
              segmentDistance(firstStart, firstEnd, secondStart, secondEnd) >=
              minimumCenterDistance - EPSILON
            ) {
              continue;
            }

            const attempts = [
              {
                traceIndex: firstIndex,
                pointIndex: firstPointIndex,
                movingStart: firstStart,
                movingEnd: firstEnd,
                blockingStart: secondStart,
                blockingEnd: secondEnd,
              },
              {
                traceIndex: secondIndex,
                pointIndex: secondPointIndex,
                movingStart: secondStart,
                movingEnd: secondEnd,
                blockingStart: firstStart,
                blockingEnd: firstEnd,
              },
            ];

            for (const attempt of attempts) {
              const margin =
                attempt.movingStart.width / 2 +
                attempt.blockingStart.width / 2 +
                clearance +
                1e-4;
              const bounds = {
                minX:
                  Math.min(attempt.blockingStart.x, attempt.blockingEnd.x) -
                  margin,
                maxX:
                  Math.max(attempt.blockingStart.x, attempt.blockingEnd.x) +
                  margin,
                minY:
                  Math.min(attempt.blockingStart.y, attempt.blockingEnd.y) -
                  margin,
                maxY:
                  Math.max(attempt.blockingStart.y, attempt.blockingEnd.y) +
                  margin,
              };
              const candidatePointPaths: Point[][] = [
                [
                  attempt.movingStart,
                  { x: bounds.minX, y: attempt.movingStart.y },
                  { x: bounds.minX, y: attempt.movingEnd.y },
                  attempt.movingEnd,
                ],
                [
                  attempt.movingStart,
                  { x: bounds.maxX, y: attempt.movingStart.y },
                  { x: bounds.maxX, y: attempt.movingEnd.y },
                  attempt.movingEnd,
                ],
                [
                  attempt.movingStart,
                  { x: attempt.movingStart.x, y: bounds.minY },
                  { x: attempt.movingEnd.x, y: bounds.minY },
                  attempt.movingEnd,
                ],
                [
                  attempt.movingStart,
                  { x: attempt.movingStart.x, y: bounds.maxY },
                  { x: attempt.movingEnd.x, y: bounds.maxY },
                  attempt.movingEnd,
                ],
              ];
              for (const escapeDistance of [
                margin + 0.1,
                margin + 0.3,
                margin + 0.6,
              ]) {
                for (const offset of [
                  { x: escapeDistance, y: 0 },
                  { x: -escapeDistance, y: 0 },
                  { x: 0, y: escapeDistance },
                  { x: 0, y: -escapeDistance },
                ]) {
                  candidatePointPaths.push(
                    [
                      attempt.movingStart,
                      {
                        x: attempt.movingStart.x + offset.x,
                        y: attempt.movingStart.y + offset.y,
                      },
                      attempt.movingEnd,
                    ],
                    [
                      attempt.movingStart,
                      {
                        x: attempt.movingEnd.x + offset.x,
                        y: attempt.movingEnd.y + offset.y,
                      },
                      attempt.movingEnd,
                    ],
                  );
                }
              }
              const boardMargin =
                (prepared.input.minBoardEdgeClearance ?? 0) +
                attempt.movingStart.width / 2;
              const segmentHasClearance = createSegmentClearanceChecker(
                prepared,
                workingSolution,
                attempt.traceIndex,
                clearance,
                false,
              );
              const candidates = candidatePointPaths
                .map((path) =>
                  collapseCollinearWirePoints(
                    toWirePath(path, attempt.movingStart),
                  ),
                )
                .filter((path) =>
                  path.every(
                    (point) =>
                      point.x >= prepared.input.bounds.minX + boardMargin &&
                      point.x <= prepared.input.bounds.maxX - boardMargin &&
                      point.y >= prepared.input.bounds.minY + boardMargin &&
                      point.y <= prepared.input.bounds.maxY - boardMargin,
                  ),
                )
                .filter((path) =>
                  path.slice(1).every((point, index) =>
                    segmentHasClearance({
                      start: path[index]!,
                      end: point,
                    }),
                  ),
                )
                .sort(
                  (left, right) =>
                    wirePathLength(left) - wirePathLength(right) ||
                    left.length - right.length,
                );
              const detour = candidates[0];
              if (!detour) continue;

              const route = [...traces[attempt.traceIndex]!.route];
              route.splice(attempt.pointIndex - 1, 2, ...detour);
              traces[attempt.traceIndex] = {
                ...traces[attempt.traceIndex]!,
                route,
              };
              repaired = true;
              break;
            }
            if (repaired) break;
          }
          if (repaired) break;
        }
        if (repaired) break;
      }
      if (repaired) break;
    }

    if (!repaired) return traces;
  }

  throw new Error(
    "Trace-to-trace clearance repair exceeded its iteration limit",
  );
};

const postProcessBiscuitBoardTracesOnce = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
): BiscuitBoardRoutingSolution => {
  const clearance = getEffectiveTraceClearance(prepared);
  let traces = repairTraceClearance(prepared, solution, clearance);
  traces = repairRotatedObstacleClearance(
    prepared,
    { ...solution, traces },
    clearance,
  );
  const repairedSolution = { ...solution, traces };
  const initialViolations = getTraceClearanceViolations(
    prepared,
    repairedSolution,
    clearance,
    true,
  );
  if (initialViolations.length > 0) {
    throw new Error(
      `Cannot post-process traces with existing clearance violations: ${initialViolations[0]!.message}`,
    );
  }

  traces = cloneTraces(repairedSolution.traces);
  const protectedJunctionKeys = new Set(
    solution.sameNetTreeJunctions?.map(junctionKey),
  );
  for (const route of solution.routes) {
    const demand = prepared.demandById.get(route.routeId)!;
    for (const endpointNode of [route.nodePath[0], route.nodePath.at(-1)]) {
      if (
        endpointNode !== undefined &&
        endpointNode !== demand.sourceNode &&
        endpointNode !== demand.targetNode
      ) {
        protectedJunctionKeys.add(junctionKey(prepared.nodes[endpointNode]!));
      }
    }
  }
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
        false,
      );
      traces[traceIndex] = {
        ...traces[traceIndex]!,
        route: simplifyTraceRoute(
          traces[traceIndex]!.route,
          segmentHasClearance,
          protectedJunctionKeys,
        ),
      };
    }
    const segmentCountAfterPass = traces.reduce(
      (count, trace) => count + getSegments(trace).length,
      0,
    );
    if (segmentCountAfterPass >= segmentCountBeforePass) break;
  }
  traces = repairRotatedObstacleClearance(
    prepared,
    { ...solution, traces },
    clearance,
    repairedSolution.traces,
  );
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
  delete output.sameNetTreeJunctions;
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

export const postProcessBiscuitBoardTraces = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
): BiscuitBoardRoutingSolution => {
  let repairPrepared = prepared;
  let repairSolution = solution;

  for (let repairAttempt = 0; repairAttempt < 8; repairAttempt++) {
    try {
      return postProcessBiscuitBoardTracesOnce(repairPrepared, repairSolution);
    } catch (error) {
      if (!(error instanceof RotatedObstacleRepairError)) throw error;
      if (
        repairPrepared.exactRotatedObstacleIndexes.includes(error.obstacleIndex)
      ) {
        throw error;
      }

      repairPrepared = {
        ...repairPrepared,
        exactRotatedObstacleIndexes: [
          ...repairPrepared.exactRotatedObstacleIndexes,
          error.obstacleIndex,
        ],
      };
      const rerouter = new RipUpRubberBandSolver(repairPrepared);
      rerouter.seedCommittedRoutes(repairSolution.routes, [error.routeId]);
      rerouter.solve();
      if (rerouter.failed) {
        throw new Error(
          `Could not reroute trace "${error.routeId}" around rotated obstacle ${error.obstacleIndex}: ${rerouter.error ?? "routing failed"}`,
        );
      }
      const builder = new BuildBiscuitBoardTracesSolver({
        prepared: repairPrepared,
        routed: rerouter.getOutput(),
      });
      builder.solve();
      const built = builder.getOutput();
      if (!built) {
        throw new Error(
          `Could not rebuild traces after rerouting "${error.routeId}"`,
        );
      }
      repairSolution = built;
    }
  }

  throw new Error("Rotated-obstacle graph repair exceeded its attempt limit");
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
      strokeDash: segment.start.layer === "bottom" ? [6, 4] : undefined,
      zIndex: 2,
      label: `simplified trace · ${route.netId} · ${segment.start.layer}`,
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

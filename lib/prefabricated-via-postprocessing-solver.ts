import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import {
  boundsOverlap,
  getRectCorners,
  pointDistance,
  pointStrictlyInsideRect,
  pointsEqual,
  segmentBounds,
  segmentDistance,
  segmentIntersectsRectInterior,
} from "./geometry";
import type {
  Point,
  PrefabricatedVia,
  RectBounds,
  ViaAssignment,
  ViaAttractionOptions,
  ViaAttractionResult,
} from "./types";

type RoutePoint = SimplifiedPcbTrace["route"][number];
type WirePoint = Extract<RoutePoint, { route_type: "wire" }>;
type ViaPoint = Extract<RoutePoint, { route_type: "via" }>;

interface ViaOccurrence {
  traceIndex: number;
  viaOrdinal: number;
  connectionName: string;
  point: ViaPoint;
}

interface TraceSegment {
  traceIndex: number;
  connectionName: string;
  layer: string;
  width: number;
  start: Point;
  end: Point;
}

interface PathSearchParams {
  start: Point;
  end: Point;
  boardBounds: RectBounds;
  rectangles: RectBounds[];
  traceSegments: TraceSegment[];
  requiredTraceClearance: number;
  searchMargin: number;
}

export interface PrefabricatedViaPostprocessingParams {
  input: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  options?: ViaAttractionOptions;
}

const cloneTraces = (traces: SimplifiedPcbTrace[]): SimplifiedPcbTrace[] =>
  traces.map((trace) => ({
    ...trace,
    connectsTo: trace.connectsTo ? [...trace.connectsTo] : undefined,
    route: trace.route.map((point) => ({ ...point })),
  }));

const getViaOccurrences = (traces: SimplifiedPcbTrace[]): ViaOccurrence[] => {
  const occurrences: ViaOccurrence[] = [];
  for (let traceIndex = 0; traceIndex < traces.length; traceIndex += 1) {
    let viaOrdinal = 0;
    for (const point of traces[traceIndex]!.route) {
      if (point.route_type !== "via") continue;
      occurrences.push({
        traceIndex,
        viaOrdinal,
        connectionName: traces[traceIndex]!.connection_name,
        point,
      });
      viaOrdinal += 1;
    }
  }
  return occurrences;
};

const getPrefabricatedVias = (input: SimpleRouteJson): PrefabricatedVia[] =>
  input.obstacles.flatMap((obstacle, obstacleIndex) => {
    if (!obstacle.netIsAssignable || obstacle.layers.length < 2) return [];
    return [
      {
        ...obstacle.center,
        obstacleIndex,
        layers: [...obstacle.layers],
        width: obstacle.width,
        height: obstacle.height,
      },
    ];
  });

const assignViasByAttraction = (
  occurrences: ViaOccurrence[],
  prefabricatedVias: PrefabricatedVia[],
): ViaAssignment[] => {
  const assignments: ViaAssignment[] = [];
  const remainingOccurrences = new Set(occurrences.map((_, index) => index));
  const remainingTargets = new Set(prefabricatedVias.map((_, index) => index));

  while (remainingOccurrences.size > 0) {
    let best:
      | { occurrenceIndex: number; targetIndex: number; distance: number }
      | undefined;
    for (const occurrenceIndex of remainingOccurrences) {
      const occurrence = occurrences[occurrenceIndex]!;
      for (const targetIndex of remainingTargets) {
        const target = prefabricatedVias[targetIndex]!;
        if (
          !target.layers.includes(occurrence.point.from_layer) ||
          !target.layers.includes(occurrence.point.to_layer)
        ) {
          continue;
        }
        const distance = pointDistance(occurrence.point, target);
        if (!best || distance < best.distance) {
          best = { occurrenceIndex, targetIndex, distance };
        }
      }
    }
    if (!best) {
      throw new Error(
        `Cannot assign ${remainingOccurrences.size} Pipeline7 via(s) to unused compatible prefabricated vias`,
      );
    }
    const occurrence = occurrences[best.occurrenceIndex]!;
    const target = prefabricatedVias[best.targetIndex]!;
    assignments.push({
      traceIndex: occurrence.traceIndex,
      viaOrdinal: occurrence.viaOrdinal,
      connectionName: occurrence.connectionName,
      from: { x: occurrence.point.x, y: occurrence.point.y },
      target,
      fromLayer: occurrence.point.from_layer,
      toLayer: occurrence.point.to_layer,
    });
    remainingOccurrences.delete(best.occurrenceIndex);
    remainingTargets.delete(best.targetIndex);
  }

  return assignments;
};

const getTraceSegments = (traces: SimplifiedPcbTrace[]): TraceSegment[] => {
  const segments: TraceSegment[] = [];
  for (let traceIndex = 0; traceIndex < traces.length; traceIndex += 1) {
    const trace = traces[traceIndex]!;
    for (let routeIndex = 1; routeIndex < trace.route.length; routeIndex += 1) {
      const start = trace.route[routeIndex - 1]!;
      const end = trace.route[routeIndex]!;
      if (
        start.route_type !== "wire" ||
        end.route_type !== "wire" ||
        start.layer !== end.layer ||
        pointsEqual(start, end)
      ) {
        continue;
      }
      segments.push({
        traceIndex,
        connectionName: trace.connection_name,
        layer: start.layer,
        width: Math.max(start.width, end.width),
        start,
        end,
      });
    }
  }
  return segments;
};

const getExpandedObstacleBounds = (
  obstacle: Obstacle,
  margin: number,
): RectBounds => {
  const rotation = ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(rotation));
  const sine = Math.abs(Math.sin(rotation));
  const halfWidth =
    (obstacle.width * cosine + obstacle.height * sine) / 2 + margin;
  const halfHeight =
    (obstacle.width * sine + obstacle.height * cosine) / 2 + margin;
  return {
    minX: obstacle.center.x - halfWidth,
    minY: obstacle.center.y - halfHeight,
    maxX: obstacle.center.x + halfWidth,
    maxY: obstacle.center.y + halfHeight,
  };
};

const isConnectedObstacle = (
  obstacle: Obstacle,
  trace: SimplifiedPcbTrace,
): boolean => {
  const allowedIdentifiers = new Set([
    trace.connection_name,
    ...(trace.connectsTo ?? []),
  ]);
  return obstacle.connectedTo.some((identifier) =>
    allowedIdentifiers.has(identifier),
  );
};

const isWithinBounds = (point: Point, bounds: RectBounds): boolean =>
  point.x >= bounds.minX &&
  point.x <= bounds.maxX &&
  point.y >= bounds.minY &&
  point.y <= bounds.maxY;

const isPathSegmentClear = (
  start: Point,
  end: Point,
  rectangles: RectBounds[],
  traceSegments: TraceSegment[],
  requiredTraceClearance: number,
): boolean => {
  if (
    rectangles.some((rectangle) =>
      segmentIntersectsRectInterior(start, end, rectangle),
    )
  ) {
    return false;
  }
  return traceSegments.every(
    (segment) =>
      segmentDistance(start, end, segment.start, segment.end) + 1e-6 >=
      requiredTraceClearance + segment.width / 2,
  );
};

const getTraceRepulsionPoints = (
  segment: TraceSegment,
  clearance: number,
): Point[] => {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return [];
  const tangentX = (dx / length) * clearance;
  const tangentY = (dy / length) * clearance;
  const offsetX = (-dy / length) * clearance;
  const offsetY = (dx / length) * clearance;
  return [
    {
      x: segment.start.x - tangentX + offsetX,
      y: segment.start.y - tangentY + offsetY,
    },
    {
      x: segment.start.x - tangentX - offsetX,
      y: segment.start.y - tangentY - offsetY,
    },
    {
      x: segment.end.x + tangentX + offsetX,
      y: segment.end.y + tangentY + offsetY,
    },
    {
      x: segment.end.x + tangentX - offsetX,
      y: segment.end.y + tangentY - offsetY,
    },
  ];
};

const deduplicatePoints = (points: Point[]): Point[] => {
  const byCoordinate = new Map<string, Point>();
  for (const point of points) {
    byCoordinate.set(`${point.x.toFixed(6)},${point.y.toFixed(6)}`, point);
  }
  return [...byCoordinate.values()];
};

/**
 * Visibility-graph relaxation. Rectangle corners and perpendicular trace
 * offsets are repulsion sites, so a moving via drags its two copper legs while
 * foreign copper pushes those legs onto a non-intersecting detour.
 */
const findRepelledPath = ({
  start,
  end,
  boardBounds,
  rectangles,
  traceSegments,
  requiredTraceClearance,
  searchMargin,
}: PathSearchParams): Point[] => {
  if (
    isPathSegmentClear(
      start,
      end,
      rectangles,
      traceSegments,
      requiredTraceClearance,
    )
  ) {
    return [start, end];
  }

  const corridor = segmentBounds(start, end, searchMargin);
  const nearbyRectangles = rectangles.filter((rectangle) =>
    boundsOverlap(rectangle, corridor),
  );
  const nearbySegments = traceSegments.filter((segment) =>
    boundsOverlap(segmentBounds(segment.start, segment.end), corridor),
  );
  const candidatePoints = deduplicatePoints([
    start,
    end,
    ...nearbyRectangles.flatMap(getRectCorners),
    ...nearbySegments.flatMap((segment) =>
      getTraceRepulsionPoints(
        segment,
        requiredTraceClearance + segment.width / 2 + 0.01,
      ),
    ),
  ]).filter(
    (point) =>
      isWithinBounds(point, boardBounds) &&
      !rectangles.some((rectangle) =>
        pointStrictlyInsideRect(point, rectangle),
      ),
  );

  const startIndex = candidatePoints.findIndex((point) =>
    pointsEqual(point, start),
  );
  const endIndex = candidatePoints.findIndex((point) =>
    pointsEqual(point, end),
  );
  if (startIndex < 0 || endIndex < 0) {
    throw new Error("Via attraction endpoints are outside the routable area");
  }

  const costs = candidatePoints.map(() => Number.POSITIVE_INFINITY);
  const previous = candidatePoints.map(() => -1);
  const visited = candidatePoints.map(() => false);
  costs[startIndex] = 0;

  for (let iteration = 0; iteration < candidatePoints.length; iteration += 1) {
    let currentIndex = -1;
    for (let index = 0; index < candidatePoints.length; index += 1) {
      if (
        !visited[index] &&
        (currentIndex < 0 || costs[index]! < costs[currentIndex]!)
      ) {
        currentIndex = index;
      }
    }
    if (currentIndex < 0 || !Number.isFinite(costs[currentIndex]!)) break;
    if (currentIndex === endIndex) break;
    visited[currentIndex] = true;
    for (
      let nextIndex = 0;
      nextIndex < candidatePoints.length;
      nextIndex += 1
    ) {
      if (visited[nextIndex] || nextIndex === currentIndex) continue;
      const current = candidatePoints[currentIndex]!;
      const next = candidatePoints[nextIndex]!;
      if (
        !isPathSegmentClear(
          current,
          next,
          rectangles,
          traceSegments,
          requiredTraceClearance,
        )
      ) {
        continue;
      }
      const nextCost = costs[currentIndex]! + pointDistance(current, next);
      if (nextCost < costs[nextIndex]!) {
        costs[nextIndex] = nextCost;
        previous[nextIndex] = currentIndex;
      }
    }
  }

  if (!Number.isFinite(costs[endIndex]!)) {
    throw new Error(
      `Trace repulsion could not reach prefabricated via at (${end.x}, ${end.y})`,
    );
  }
  const path: Point[] = [];
  for (let index = endIndex; index >= 0; index = previous[index]!) {
    path.push(candidatePoints[index]!);
    if (index === startIndex) break;
  }
  return path.reverse();
};

const makeWirePoint = (
  point: Point,
  layer: string,
  width: number,
): WirePoint => ({
  route_type: "wire",
  x: point.x,
  y: point.y,
  layer,
  width,
});

const getViaRouteIndex = (
  trace: SimplifiedPcbTrace,
  viaOrdinal: number,
): number => {
  let currentOrdinal = 0;
  for (let index = 0; index < trace.route.length; index += 1) {
    if (trace.route[index]!.route_type !== "via") continue;
    if (currentOrdinal === viaOrdinal) return index;
    currentOrdinal += 1;
  }
  throw new Error(
    `Missing via ${viaOrdinal} on trace ${trace.connection_name}`,
  );
};

const findDistinctWireIndex = (
  route: RoutePoint[],
  viaIndex: number,
  direction: -1 | 1,
  via: ViaPoint,
): number => {
  for (
    let index = viaIndex + direction;
    index >= 0 && index < route.length;
    index += direction
  ) {
    const point = route[index]!;
    if (point.route_type === "via") break;
    if (point.route_type === "wire" && !pointsEqual(point, via)) return index;
  }
  throw new Error(
    `Cannot move via ${viaIndex}: it has no distinct wire anchor on one side`,
  );
};

const getBlockingRectangles = ({
  input,
  trace,
  layer,
  targetObstacleIndex,
  wireWidth,
  clearance,
}: {
  input: SimpleRouteJson;
  trace: SimplifiedPcbTrace;
  layer: string;
  targetObstacleIndex: number;
  wireWidth: number;
  clearance: number;
}): RectBounds[] =>
  input.obstacles.flatMap((obstacle, obstacleIndex) => {
    if (
      obstacleIndex === targetObstacleIndex ||
      obstacle.isCopperPour ||
      !obstacle.layers.includes(layer) ||
      isConnectedObstacle(obstacle, trace)
    ) {
      return [];
    }
    return [getExpandedObstacleBounds(obstacle, wireWidth / 2 + clearance)];
  });

const moveViaAndRelaxTrace = ({
  input,
  traces,
  assignment,
  clearance,
  searchMargin,
}: {
  input: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  assignment: ViaAssignment;
  clearance: number;
  searchMargin: number;
}): number => {
  const trace = traces[assignment.traceIndex]!;
  const viaIndex = getViaRouteIndex(trace, assignment.viaOrdinal);
  const via = trace.route[viaIndex]!;
  if (via.route_type !== "via") throw new Error("Expected a via route point");
  const leftAnchorIndex = findDistinctWireIndex(trace.route, viaIndex, -1, via);
  const rightAnchorIndex = findDistinctWireIndex(trace.route, viaIndex, 1, via);
  const leftAnchor = trace.route[leftAnchorIndex]!;
  const rightAnchor = trace.route[rightAnchorIndex]!;
  if (leftAnchor.route_type !== "wire" || rightAnchor.route_type !== "wire") {
    throw new Error("Via trace anchors must be wire points");
  }

  const foreignSegments = getTraceSegments(traces).filter(
    (segment) =>
      segment.traceIndex !== assignment.traceIndex &&
      segment.connectionName !== trace.connection_name,
  );
  const boardBounds = {
    minX: input.bounds.minX + clearance,
    minY: input.bounds.minY + clearance,
    maxX: input.bounds.maxX - clearance,
    maxY: input.bounds.maxY - clearance,
  };
  const leftPath = findRepelledPath({
    start: leftAnchor,
    end: assignment.target,
    boardBounds,
    rectangles: getBlockingRectangles({
      input,
      trace,
      layer: leftAnchor.layer,
      targetObstacleIndex: assignment.target.obstacleIndex,
      wireWidth: leftAnchor.width,
      clearance,
    }),
    traceSegments: foreignSegments.filter(
      (segment) => segment.layer === leftAnchor.layer,
    ),
    requiredTraceClearance: leftAnchor.width / 2 + clearance,
    searchMargin,
  });
  const rightPath = findRepelledPath({
    start: assignment.target,
    end: rightAnchor,
    boardBounds,
    rectangles: getBlockingRectangles({
      input,
      trace,
      layer: rightAnchor.layer,
      targetObstacleIndex: assignment.target.obstacleIndex,
      wireWidth: rightAnchor.width,
      clearance,
    }),
    traceSegments: foreignSegments.filter(
      (segment) => segment.layer === rightAnchor.layer,
    ),
    requiredTraceClearance: rightAnchor.width / 2 + clearance,
    searchMargin,
  });
  const movedVia: ViaPoint = {
    ...via,
    x: assignment.target.x,
    y: assignment.target.y,
  };
  trace.route = [
    ...trace.route.slice(0, leftAnchorIndex + 1),
    ...leftPath
      .slice(1)
      .map((point) => makeWirePoint(point, leftAnchor.layer, leftAnchor.width)),
    movedVia,
    ...rightPath
      .slice(0, -1)
      .map((point) =>
        makeWirePoint(point, rightAnchor.layer, rightAnchor.width),
      ),
    ...trace.route.slice(rightAnchorIndex),
  ];
  return Number(leftPath.length > 2) + Number(rightPath.length > 2);
};

const validateFixedViaInvariant = (
  traces: SimplifiedPcbTrace[],
  assignments: ViaAssignment[],
): void => {
  const allowedTargets = new Set(
    assignments.map(
      (assignment) =>
        `${assignment.target.x.toFixed(6)},${assignment.target.y.toFixed(6)}`,
    ),
  );
  for (const trace of traces) {
    for (const point of trace.route) {
      if (point.route_type !== "via") continue;
      const key = `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
      if (!allowedTargets.has(key)) {
        throw new Error(
          `Post-processing left a manufacturing via at (${point.x}, ${point.y})`,
        );
      }
    }
  }
};

const visualizeResult = (
  input: SimpleRouteJson,
  result: ViaAttractionResult,
): GraphicsObject => ({
  title: "Pipeline7 with prefabricated-via attraction",
  rects: input.obstacles
    .filter((obstacle) => !obstacle.isCopperPour)
    .map((obstacle) => ({
      center: obstacle.center,
      width: obstacle.width,
      height: obstacle.height,
      fill: obstacle.netIsAssignable
        ? "rgba(14,165,233,0.20)"
        : "rgba(100,116,139,0.08)",
      stroke: obstacle.netIsAssignable
        ? "rgba(2,132,199,0.65)"
        : "rgba(100,116,139,0.25)",
    })),
  lines: result.traces.flatMap((trace) => {
    const lines: NonNullable<GraphicsObject["lines"]> = [];
    for (let index = 1; index < trace.route.length; index += 1) {
      const start = trace.route[index - 1]!;
      const end = trace.route[index]!;
      if (
        start.route_type === "wire" &&
        end.route_type === "wire" &&
        start.layer === end.layer
      ) {
        lines.push({
          points: [start, end],
          strokeColor:
            start.layer === "top"
              ? "rgba(220,38,38,0.9)"
              : "rgba(37,99,235,0.9)",
          strokeWidth: Math.max(start.width, end.width),
        });
      }
    }
    return lines;
  }),
  points: result.assignments.flatMap((assignment) => [
    {
      ...assignment.from,
      color: "rgba(245,158,11,0.8)",
      label: `Pipeline7 via · ${assignment.connectionName}`,
    },
    {
      ...assignment.target,
      color: "rgba(14,165,233,0.95)",
      label: `prefabricated via · ${assignment.connectionName}`,
    },
  ]),
});

export class PrefabricatedViaPostprocessingSolver extends BaseSolver {
  private result: ViaAttractionResult | null = null;

  constructor(public readonly params: PrefabricatedViaPostprocessingParams) {
    super();
    this.MAX_ITERATIONS = 2;
  }

  override getConstructorParams(): [PrefabricatedViaPostprocessingParams] {
    return [this.params];
  }

  override _step(): void {
    const traces = cloneTraces(this.params.traces);
    const occurrences = getViaOccurrences(traces);
    const prefabricatedVias = getPrefabricatedVias(this.params.input);
    const assignments = assignViasByAttraction(occurrences, prefabricatedVias);
    const clearance =
      this.params.options?.clearance ??
      this.params.input.defaultObstacleMargin ??
      0.15;
    const searchMargin = this.params.options?.detourSearchMargin ?? 4;
    let repelledTraceLegCount = 0;

    for (const assignment of [...assignments].sort(
      (left, right) =>
        right.traceIndex - left.traceIndex ||
        right.viaOrdinal - left.viaOrdinal,
    )) {
      repelledTraceLegCount += moveViaAndRelaxTrace({
        input: this.params.input,
        traces,
        assignment,
        clearance,
        searchMargin,
      });
    }
    validateFixedViaInvariant(traces, assignments);
    this.result = {
      traces,
      assignments,
      stats: {
        inputViaCount: occurrences.length,
        movedViaCount: assignments.filter(
          (assignment) => !pointsEqual(assignment.from, assignment.target),
        ).length,
        repelledTraceLegCount,
        maximumViaMovement: Math.max(
          0,
          ...assignments.map((assignment) =>
            pointDistance(assignment.from, assignment.target),
          ),
        ),
      },
    };
    this.progress = 1;
    this.solved = true;
  }

  override getOutput(): ViaAttractionResult | null {
    return this.result;
  }

  override visualize(): GraphicsObject {
    if (!this.result) return { title: "Prefabricated-via attraction" };
    return visualizeResult(this.params.input, this.result);
  }
}

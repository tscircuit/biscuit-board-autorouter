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
type ThroughObstaclePoint = Extract<
  RoutePoint,
  { route_type: "through_obstacle" }
>;

interface ViaOccurrence {
  traceIndex: number;
  viaOrdinal: number;
  connectionName: string;
  point: ViaPoint;
}

interface TraceSegment {
  traceIndex: number;
  startRouteIndex: number;
  endRouteIndex: number;
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
  allowTraceCrossingFallback?: boolean;
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
        startRouteIndex: routeIndex - 1,
        endRouteIndex: routeIndex,
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

const tryFindRepelledPath = ({
  start,
  end,
  boardBounds,
  rectangles,
  traceSegments,
  requiredTraceClearance,
  searchMargin,
}: PathSearchParams): Point[] | null => {
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

  if (!Number.isFinite(costs[endIndex]!)) return null;
  const path: Point[] = [];
  for (let index = endIndex; index >= 0; index = previous[index]!) {
    path.push(candidatePoints[index]!);
    if (index === startIndex) break;
  }
  return path.reverse();
};

interface GridQueueItem {
  key: string;
  priority: number;
}

class GridMinHeap {
  private readonly items: GridQueueItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: GridQueueItem): void {
    this.items.push(item);
    for (let index = this.items.length - 1; index > 0; ) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.priority <= item.priority) break;
      this.items[index] = this.items[parent]!;
      index = parent;
      this.items[index] = item;
    }
  }

  pop(): GridQueueItem | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;
    this.items[0] = last;
    for (let index = 0; ; ) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < this.items.length &&
        this.items[left]!.priority < this.items[smallest]!.priority
      ) {
        smallest = left;
      }
      if (
        right < this.items.length &&
        this.items[right]!.priority < this.items[smallest]!.priority
      ) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [
        this.items[smallest]!,
        this.items[index]!,
      ];
      index = smallest;
    }
    return first;
  }
}

const simplifyRepelledPath = (
  path: Point[],
  params: PathSearchParams,
): Point[] => {
  const simplified: Point[] = [];
  for (let startIndex = 0; startIndex < path.length - 1; ) {
    simplified.push(path[startIndex]!);
    let endIndex = path.length - 1;
    while (
      endIndex > startIndex + 1 &&
      !isPathSegmentClear(
        path[startIndex]!,
        path[endIndex]!,
        params.rectangles,
        params.traceSegments,
        params.requiredTraceClearance,
      )
    ) {
      endIndex -= 1;
    }
    startIndex = endIndex;
  }
  simplified.push(path.at(-1)!);
  return simplified;
};

const tryFindGridRepelledPath = (params: PathSearchParams): Point[] | null => {
  const pitch = Math.max(0.75, params.requiredTraceClearance);
  const xCount =
    Math.floor((params.boardBounds.maxX - params.boardBounds.minX) / pitch) + 1;
  const yCount =
    Math.floor((params.boardBounds.maxY - params.boardBounds.minY) / pitch) + 1;
  const startKey = "start";
  const endKey = "end";
  const pointCache = new Map<string, Point>();
  const validPointCache = new Map<string, boolean>();
  const gridKey = (xIndex: number, yIndex: number): string =>
    `${xIndex}:${yIndex}`;
  const getPoint = (key: string): Point => {
    if (key === startKey) return params.start;
    if (key === endKey) return params.end;
    const cached = pointCache.get(key);
    if (cached) return cached;
    const [xIndex, yIndex] = key.split(":").map(Number);
    const point = {
      x: params.boardBounds.minX + xIndex! * pitch,
      y: params.boardBounds.minY + yIndex! * pitch,
    };
    pointCache.set(key, point);
    return point;
  };
  const isValidGridPoint = (key: string): boolean => {
    const cached = validPointCache.get(key);
    if (cached !== undefined) return cached;
    const point = getPoint(key);
    const valid =
      isWithinBounds(point, params.boardBounds) &&
      isPathSegmentClear(
        point,
        point,
        params.rectangles,
        params.traceSegments,
        params.requiredTraceClearance,
      );
    validPointCache.set(key, valid);
    return valid;
  };
  const getNearbyGridKeys = (point: Point, radius: number): string[] => {
    const centerX = Math.round((point.x - params.boardBounds.minX) / pitch);
    const centerY = Math.round((point.y - params.boardBounds.minY) / pitch);
    const keys: string[] = [];
    for (let xOffset = -radius; xOffset <= radius; xOffset += 1) {
      for (let yOffset = -radius; yOffset <= radius; yOffset += 1) {
        const xIndex = centerX + xOffset;
        const yIndex = centerY + yOffset;
        if (xIndex < 0 || xIndex >= xCount || yIndex < 0 || yIndex >= yCount) {
          continue;
        }
        const key = gridKey(xIndex, yIndex);
        if (isValidGridPoint(key)) keys.push(key);
      }
    }
    return keys;
  };
  const getNeighbors = (key: string): string[] => {
    const point = getPoint(key);
    if (key === endKey) return [];
    const candidateKeys: string[] = [];
    if (key === startKey) {
      candidateKeys.push(...getNearbyGridKeys(point, 4));
    } else {
      const [xIndex, yIndex] = key.split(":").map(Number);
      for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
        for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
          if (xOffset === 0 && yOffset === 0) continue;
          const nextX = xIndex! + xOffset;
          const nextY = yIndex! + yOffset;
          if (nextX < 0 || nextX >= xCount || nextY < 0 || nextY >= yCount) {
            continue;
          }
          const nextKey = gridKey(nextX, nextY);
          if (isValidGridPoint(nextKey)) candidateKeys.push(nextKey);
        }
      }
      if (pointDistance(point, params.end) <= pitch * 6) {
        candidateKeys.push(endKey);
      }
    }
    return candidateKeys.filter((candidateKey) =>
      isPathSegmentClear(
        point,
        getPoint(candidateKey),
        params.rectangles,
        params.traceSegments,
        params.requiredTraceClearance,
      ),
    );
  };

  const queue = new GridMinHeap();
  const costs = new Map<string, number>([[startKey, 0]]);
  const previous = new Map<string, string>();
  const visited = new Set<string>();
  queue.push({
    key: startKey,
    priority: pointDistance(params.start, params.end),
  });
  while (queue.size > 0) {
    const current = queue.pop()!;
    if (visited.has(current.key)) continue;
    if (current.key === endKey) break;
    visited.add(current.key);
    const currentPoint = getPoint(current.key);
    for (const nextKey of getNeighbors(current.key)) {
      const nextPoint = getPoint(nextKey);
      const nextCost =
        costs.get(current.key)! + pointDistance(currentPoint, nextPoint);
      if (nextCost >= (costs.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      costs.set(nextKey, nextCost);
      previous.set(nextKey, current.key);
      queue.push({
        key: nextKey,
        priority: nextCost + pointDistance(nextPoint, params.end),
      });
    }
  }
  if (!costs.has(endKey)) return null;
  const path: Point[] = [];
  for (let key: string | undefined = endKey; key; key = previous.get(key)) {
    path.push(getPoint(key));
    if (key === startKey) break;
  }
  return simplifyRepelledPath(path.reverse(), params);
};

/**
 * Visibility-graph relaxation. Rectangle corners and perpendicular trace
 * offsets are repulsion sites, so a moving via drags its two copper legs while
 * foreign copper pushes those legs onto a non-intersecting detour.
 */
const findRepelledPath = (params: PathSearchParams): Point[] => {
  if (
    isPathSegmentClear(
      params.start,
      params.end,
      params.rectangles,
      params.traceSegments,
      params.requiredTraceClearance,
    )
  ) {
    return [params.start, params.end];
  }

  const boardSpan = Math.max(
    params.boardBounds.maxX - params.boardBounds.minX,
    params.boardBounds.maxY - params.boardBounds.minY,
  );
  const searchMargins = [
    params.searchMargin,
    params.searchMargin * 2,
    boardSpan,
  ];
  for (const searchMargin of new Set(searchMargins)) {
    const path = tryFindRepelledPath({ ...params, searchMargin });
    if (path) return path;
  }
  if (params.allowTraceCrossingFallback && params.traceSegments.length > 0) {
    return findRepelledPath({
      ...params,
      traceSegments: [],
      allowTraceCrossingFallback: false,
    });
  }
  const gridPath = tryFindGridRepelledPath(params);
  if (gridPath) return gridPath;
  throw new Error(
    `Trace repulsion could not connect (${params.start.x}, ${params.start.y}) to (${params.end.x}, ${params.end.y})`,
  );
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
  ignoredObstacleIndexes,
  wireWidth,
  clearance,
}: {
  input: SimpleRouteJson;
  trace: SimplifiedPcbTrace;
  layer: string;
  ignoredObstacleIndexes: Set<number>;
  wireWidth: number;
  clearance: number;
}): RectBounds[] =>
  input.obstacles.flatMap((obstacle, obstacleIndex) => {
    if (
      ignoredObstacleIndexes.has(obstacleIndex) ||
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
      ignoredObstacleIndexes: new Set([assignment.target.obstacleIndex]),
      wireWidth: leftAnchor.width,
      clearance,
    }),
    traceSegments: foreignSegments.filter(
      (segment) => segment.layer === leftAnchor.layer,
    ),
    requiredTraceClearance: leftAnchor.width / 2 + clearance,
    searchMargin,
    allowTraceCrossingFallback: true,
  });
  const rightPath = findRepelledPath({
    start: assignment.target,
    end: rightAnchor,
    boardBounds,
    rectangles: getBlockingRectangles({
      input,
      trace,
      layer: rightAnchor.layer,
      ignoredObstacleIndexes: new Set([assignment.target.obstacleIndex]),
      wireWidth: rightAnchor.width,
      clearance,
    }),
    traceSegments: foreignSegments.filter(
      (segment) => segment.layer === rightAnchor.layer,
    ),
    requiredTraceClearance: rightAnchor.width / 2 + clearance,
    searchMargin,
    allowTraceCrossingFallback: true,
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

const getFirstTraceCollision = (
  traces: SimplifiedPcbTrace[],
  clearance: number,
): [TraceSegment, TraceSegment] | null => {
  const segments = getTraceSegments(traces);
  for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
    const first = segments[firstIndex]!;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < segments.length;
      secondIndex += 1
    ) {
      const second = segments[secondIndex]!;
      if (
        first.traceIndex === second.traceIndex ||
        first.connectionName === second.connectionName ||
        first.layer !== second.layer
      ) {
        continue;
      }
      const requiredClearance = first.width / 2 + second.width / 2 + clearance;
      if (
        segmentDistance(first.start, first.end, second.start, second.end) +
          1e-6 <
        requiredClearance
      ) {
        return [first, second];
      }
    }
  }
  return null;
};

const repelTraceSegment = ({
  input,
  traces,
  movingSegment,
  blockingSegment,
  assignments,
  clearance,
  searchMargin,
}: {
  input: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  movingSegment: TraceSegment;
  blockingSegment: TraceSegment;
  assignments: ViaAssignment[];
  clearance: number;
  searchMargin: number;
}): boolean => {
  const trace = traces[movingSegment.traceIndex]!;
  const ignoredObstacleIndexes = new Set(
    assignments
      .filter(
        (assignment) => assignment.traceIndex === movingSegment.traceIndex,
      )
      .map((assignment) => assignment.target.obstacleIndex),
  );
  const foreignSegments = getTraceSegments(traces).filter(
    (segment) =>
      segment.traceIndex !== movingSegment.traceIndex &&
      segment.connectionName !== movingSegment.connectionName,
  );
  const rectangles = getBlockingRectangles({
    input,
    trace,
    layer: movingSegment.layer,
    ignoredObstacleIndexes,
    wireWidth: movingSegment.width,
    clearance,
  });
  const blockerDx = blockingSegment.end.x - blockingSegment.start.x;
  const blockerDy = blockingSegment.end.y - blockingSegment.start.y;
  const blockerLength = Math.hypot(blockerDx, blockerDy);
  const movingDx = movingSegment.end.x - movingSegment.start.x;
  const movingDy = movingSegment.end.y - movingSegment.start.y;
  const denominator = movingDx * blockerDy - movingDy * blockerDx;
  if (blockerLength > 1e-9 && Math.abs(denominator) > 1e-9) {
    const deltaX = blockingSegment.start.x - movingSegment.start.x;
    const deltaY = blockingSegment.start.y - movingSegment.start.y;
    const movingRatio = (deltaX * blockerDy - deltaY * blockerDx) / denominator;
    const intersection = {
      x: movingSegment.start.x + movingRatio * movingDx,
      y: movingSegment.start.y + movingRatio * movingDy,
    };
    const normal = {
      x: -blockerDy / blockerLength,
      y: blockerDx / blockerLength,
    };
    const movingLength = Math.hypot(movingDx, movingDy);
    const movingUnit = {
      x: movingDx / movingLength,
      y: movingDy / movingLength,
    };
    const requiredOffset =
      movingSegment.width / 2 + blockingSegment.width / 2 + clearance + 0.02;
    for (const side of [-1, 1]) {
      for (const leadMultiplier of [2, 4, 8]) {
        const lead = requiredOffset * leadMultiplier;
        const candidatePath = [
          movingSegment.start,
          {
            x:
              intersection.x -
              movingUnit.x * lead +
              normal.x * requiredOffset * side,
            y:
              intersection.y -
              movingUnit.y * lead +
              normal.y * requiredOffset * side,
          },
          {
            x:
              intersection.x +
              movingUnit.x * lead +
              normal.x * requiredOffset * side,
            y:
              intersection.y +
              movingUnit.y * lead +
              normal.y * requiredOffset * side,
          },
          movingSegment.end,
        ];
        const candidateIsClear =
          candidatePath.every((point) =>
            isWithinBounds(point, {
              minX: input.bounds.minX + clearance,
              minY: input.bounds.minY + clearance,
              maxX: input.bounds.maxX - clearance,
              maxY: input.bounds.maxY - clearance,
            }),
          ) &&
          candidatePath.slice(1).every((end, index) =>
            isPathSegmentClear(
              candidatePath[index]!,
              end,
              rectangles,
              foreignSegments.filter(
                (segment) => segment.layer === movingSegment.layer,
              ),
              movingSegment.width / 2 + clearance,
            ),
          );
        if (!candidateIsClear) continue;
        trace.route = [
          ...trace.route.slice(0, movingSegment.startRouteIndex + 1),
          ...candidatePath
            .slice(1, -1)
            .map((point) =>
              makeWirePoint(point, movingSegment.layer, movingSegment.width),
            ),
          ...trace.route.slice(movingSegment.endRouteIndex),
        ];
        return true;
      }
    }
  }
  let path: Point[];
  try {
    path = findRepelledPath({
      start: movingSegment.start,
      end: movingSegment.end,
      boardBounds: {
        minX: input.bounds.minX + clearance,
        minY: input.bounds.minY + clearance,
        maxX: input.bounds.maxX - clearance,
        maxY: input.bounds.maxY - clearance,
      },
      rectangles,
      traceSegments: foreignSegments.filter(
        (segment) => segment.layer === movingSegment.layer,
      ),
      requiredTraceClearance: movingSegment.width / 2 + clearance,
      searchMargin,
      allowTraceCrossingFallback: false,
    });
  } catch {
    return false;
  }
  if (path.length <= 2) return false;
  trace.route = [
    ...trace.route.slice(0, movingSegment.startRouteIndex + 1),
    ...path
      .slice(1, -1)
      .map((point) =>
        makeWirePoint(point, movingSegment.layer, movingSegment.width),
      ),
    ...trace.route.slice(movingSegment.endRouteIndex),
  ];
  return true;
};

/** Resolves crossings introduced by a via pull by pushing either trace aside. */
const repelIntroducedTraceCollisions = ({
  input,
  traces,
  assignments,
  clearance,
  searchMargin,
}: {
  input: SimpleRouteJson;
  traces: SimplifiedPcbTrace[];
  assignments: ViaAssignment[];
  clearance: number;
  searchMargin: number;
}): number => {
  let repelledSegmentCount = 0;
  for (let iteration = 0; iteration < 250; iteration += 1) {
    const collision = getFirstTraceCollision(traces, clearance);
    if (!collision) return repelledSegmentCount;
    const [first, second] = collision;
    const firstCandidate = cloneTraces(traces);
    if (
      repelTraceSegment({
        input,
        traces: firstCandidate,
        movingSegment: first,
        blockingSegment: second,
        assignments,
        clearance,
        searchMargin,
      })
    ) {
      traces.splice(0, traces.length, ...firstCandidate);
      repelledSegmentCount += 1;
      continue;
    }
    const secondCandidate = cloneTraces(traces);
    if (
      repelTraceSegment({
        input,
        traces: secondCandidate,
        movingSegment: second,
        blockingSegment: first,
        assignments,
        clearance,
        searchMargin,
      })
    ) {
      traces.splice(0, traces.length, ...secondCandidate);
      repelledSegmentCount += 1;
      continue;
    }
    throw new Error(
      `Trace repulsion could not separate "${first.connectionName}" (${first.start.x}, ${first.start.y})-(${first.end.x}, ${first.end.y}) from "${second.connectionName}" (${second.start.x}, ${second.start.y})-(${second.end.x}, ${second.end.y})`,
    );
  }
  throw new Error("Trace repulsion exceeded 250 collision-resolution moves");
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

const replaceAssignedViasWithExistingCopperTransitions = (
  traces: SimplifiedPcbTrace[],
  assignments: ViaAssignment[],
  fallbackWidth: number,
): SimplifiedPcbTrace[] =>
  traces.map((trace, traceIndex) => {
    let viaOrdinal = 0;
    return {
      ...trace,
      route: trace.route.map((point, routeIndex): RoutePoint => {
        if (point.route_type !== "via") return point;
        const assignment = assignments.find(
          (candidate) =>
            candidate.traceIndex === traceIndex &&
            candidate.viaOrdinal === viaOrdinal,
        );
        viaOrdinal += 1;
        if (!assignment) {
          throw new Error(
            `Missing prefabricated-via assignment for via ${viaOrdinal - 1} on "${trace.connection_name}"`,
          );
        }
        const adjacentWidth = [
          trace.route[routeIndex - 1],
          trace.route[routeIndex + 1],
        ].find(
          (adjacent): adjacent is WirePoint => adjacent?.route_type === "wire",
        )?.width;
        return {
          route_type: "through_obstacle",
          start: { x: assignment.target.x, y: assignment.target.y },
          end: { x: assignment.target.x, y: assignment.target.y },
          from_layer: assignment.fromLayer,
          to_layer: assignment.toLayer,
          width: adjacentWidth ?? fallbackWidth,
        } satisfies ThroughObstaclePoint;
      }),
    };
  });

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
    let traces = cloneTraces(this.params.traces);
    const occurrences = getViaOccurrences(traces);
    const prefabricatedVias = getPrefabricatedVias(this.params.input);
    const assignments: ViaAssignment[] = [];
    const usedTargetObstacleIndexes = new Set<number>();
    const clearance =
      this.params.options?.clearance ??
      this.params.input.defaultObstacleMargin ??
      0.15;
    const searchMargin = this.params.options?.detourSearchMargin ?? 4;
    let repelledTraceLegCount = 0;

    const orderedOccurrences = [...occurrences].sort((left, right) => {
      const getNearestDistance = (occurrence: ViaOccurrence): number =>
        Math.min(
          Number.POSITIVE_INFINITY,
          ...prefabricatedVias
            .filter(
              (target) =>
                target.layers.includes(occurrence.point.from_layer) &&
                target.layers.includes(occurrence.point.to_layer),
            )
            .map((target) => pointDistance(occurrence.point, target)),
        );
      return getNearestDistance(left) - getNearestDistance(right);
    });

    for (const occurrence of orderedOccurrences) {
      const candidates = prefabricatedVias
        .filter(
          (target) =>
            !usedTargetObstacleIndexes.has(target.obstacleIndex) &&
            target.layers.includes(occurrence.point.from_layer) &&
            target.layers.includes(occurrence.point.to_layer),
        )
        .sort(
          (left, right) =>
            pointDistance(occurrence.point, left) -
            pointDistance(occurrence.point, right),
        );
      let selected:
        | {
            assignment: ViaAssignment;
            traces: SimplifiedPcbTrace[];
            repelledTraceLegCount: number;
          }
        | undefined;
      let lastFailure: unknown;
      for (const target of candidates) {
        const assignment: ViaAssignment = {
          traceIndex: occurrence.traceIndex,
          viaOrdinal: occurrence.viaOrdinal,
          connectionName: occurrence.connectionName,
          from: { x: occurrence.point.x, y: occurrence.point.y },
          target,
          fromLayer: occurrence.point.from_layer,
          toLayer: occurrence.point.to_layer,
        };
        const candidateTraces = cloneTraces(traces);
        try {
          let repelledLegCount = moveViaAndRelaxTrace({
            input: this.params.input,
            traces: candidateTraces,
            assignment,
            clearance,
            searchMargin,
          });
          repelledLegCount += repelIntroducedTraceCollisions({
            input: this.params.input,
            traces: candidateTraces,
            assignments: [...assignments, assignment],
            clearance,
            searchMargin,
          });
          selected = {
            assignment,
            traces: candidateTraces,
            repelledTraceLegCount: repelledLegCount,
          };
          break;
        } catch (error) {
          lastFailure = error;
        }
      }
      if (!selected) {
        const suffix =
          lastFailure instanceof Error ? `: ${lastFailure.message}` : "";
        throw new Error(
          `Cannot assign Pipeline7 via ${occurrence.viaOrdinal} on "${occurrence.connectionName}" to an unused reachable compatible prefabricated via${suffix}`,
        );
      }
      traces = selected.traces;
      const selectedTrace = traces[selected.assignment.traceIndex]!;
      const targetIdentifiers =
        this.params.input.obstacles[selected.assignment.target.obstacleIndex]!
          .connectedTo;
      selectedTrace.connectsTo = [
        ...(selectedTrace.connectsTo ?? []),
        ...targetIdentifiers,
      ].filter(
        (identifier, index, identifiers) =>
          identifiers.indexOf(identifier) === index,
      );
      assignments.push(selected.assignment);
      usedTargetObstacleIndexes.add(selected.assignment.target.obstacleIndex);
      repelledTraceLegCount += selected.repelledTraceLegCount;
    }
    repelledTraceLegCount += repelIntroducedTraceCollisions({
      input: this.params.input,
      traces,
      assignments,
      clearance,
      searchMargin,
    });
    validateFixedViaInvariant(traces, assignments);
    traces = replaceAssignedViasWithExistingCopperTransitions(
      traces,
      assignments,
      this.params.input.minTraceWidth,
    );
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

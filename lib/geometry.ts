import type { GraphicsObject } from "graphics-debug";
import type {
  Point,
  PreparedBiscuitRoutingProblem,
  RectBounds,
  RoutedConnection,
  RoutingEdge,
} from "./types";

const EPSILON = 1e-7;

export const pointsEqual = (a: Point, b: Point, epsilon = EPSILON) =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;

export const pointDistance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export const pointStrictlyInsideRect = (point: Point, rect: RectBounds) =>
  point.x > rect.minX + EPSILON &&
  point.x < rect.maxX - EPSILON &&
  point.y > rect.minY + EPSILON &&
  point.y < rect.maxY - EPSILON;

export const obstacleBounds = (
  obstacle: {
    center: Point;
    width: number;
    height: number;
  },
  margin = 0,
): RectBounds => ({
  minX: obstacle.center.x - obstacle.width / 2 - margin,
  maxX: obstacle.center.x + obstacle.width / 2 + margin,
  minY: obstacle.center.y - obstacle.height / 2 - margin,
  maxY: obstacle.center.y + obstacle.height / 2 + margin,
});

/** Liang-Barsky clipping against a slightly shrunken rectangle. */
export const segmentIntersectsRectInterior = (
  start: Point,
  end: Point,
  rect: RectBounds,
) => {
  const interior = {
    minX: rect.minX + EPSILON,
    maxX: rect.maxX - EPSILON,
    minY: rect.minY + EPSILON,
    maxY: rect.maxY - EPSILON,
  };
  if (interior.minX >= interior.maxX || interior.minY >= interior.maxY) {
    return false;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const p = [-dx, dx, -dy, dy];
  const q = [
    start.x - interior.minX,
    interior.maxX - start.x,
    start.y - interior.minY,
    interior.maxY - start.y,
  ];
  let low = 0;
  let high = 1;
  for (let index = 0; index < 4; index++) {
    if (Math.abs(p[index]!) <= EPSILON) {
      if (q[index]! < 0) return false;
      continue;
    }
    const ratio = q[index]! / p[index]!;
    if (p[index]! < 0) low = Math.max(low, ratio);
    else high = Math.min(high, ratio);
    if (low > high) return false;
  }
  return high >= 0 && low <= 1;
};

const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const onSegment = (a: Point, b: Point, point: Point) =>
  Math.abs(cross(a, b, point)) <= EPSILON &&
  point.x >= Math.min(a.x, b.x) - EPSILON &&
  point.x <= Math.max(a.x, b.x) + EPSILON &&
  point.y >= Math.min(a.y, b.y) - EPSILON &&
  point.y <= Math.max(a.y, b.y) + EPSILON;

export const segmentsIntersect = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) => {
  const c1 = cross(firstStart, firstEnd, secondStart);
  const c2 = cross(firstStart, firstEnd, secondEnd);
  const c3 = cross(secondStart, secondEnd, firstStart);
  const c4 = cross(secondStart, secondEnd, firstEnd);
  if (
    ((c1 > EPSILON && c2 < -EPSILON) || (c1 < -EPSILON && c2 > EPSILON)) &&
    ((c3 > EPSILON && c4 < -EPSILON) || (c3 < -EPSILON && c4 > EPSILON))
  ) {
    return true;
  }
  return (
    onSegment(firstStart, firstEnd, secondStart) ||
    onSegment(firstStart, firstEnd, secondEnd) ||
    onSegment(secondStart, secondEnd, firstStart) ||
    onSegment(secondStart, secondEnd, firstEnd)
  );
};

export const getEdgePoints = (
  prepared: PreparedBiscuitRoutingProblem,
  edge: RoutingEdge,
) => [prepared.nodes[edge.fromNode]!, prepared.nodes[edge.toNode]!] as const;

export const netColor = (name: string) => {
  let hash = 0;
  for (const character of name)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 72% 42%)`;
};

export const visualizePreparedProblem = (
  prepared: PreparedBiscuitRoutingProblem,
  routes: Iterable<RoutedConnection> = [],
): GraphicsObject => {
  const lines: NonNullable<GraphicsObject["lines"]> = [];
  const points: NonNullable<GraphicsObject["points"]> = [];
  const rects: NonNullable<GraphicsObject["rects"]> = [];
  const margin =
    prepared.input.minTraceWidth / 2 + prepared.options.gridClearance;

  for (const obstacle of prepared.input.obstacles) {
    if (obstacle.isCopperPour) continue;
    const bounds = obstacleBounds(obstacle, margin);
    rects.push({
      center: {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      },
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      fill: obstacle.netIsAssignable
        ? "rgba(14,165,233,0.20)"
        : "rgba(239,68,68,0.12)",
      stroke: obstacle.netIsAssignable
        ? "rgba(2,132,199,0.7)"
        : "rgba(220,38,38,0.35)",
    });
  }

  for (const edge of prepared.edges) {
    const [from, to] = getEdgePoints(prepared, edge);
    if (edge.kind === "trace") {
      lines.push({
        points: [from, to],
        strokeColor: "rgba(100,116,139,0.10)",
        strokeWidth: 0.025,
      });
    } else {
      points.push({
        ...from,
        color: "rgba(14,165,233,0.75)",
        label: edge.prefabViaId,
      });
    }
  }

  for (const route of routes) {
    const color = netColor(route.netId);
    for (const edgeId of route.edgePath) {
      const edge = prepared.edges[edgeId]!;
      const [from, to] = getEdgePoints(prepared, edge);
      if (edge.kind === "trace") {
        lines.push({
          points: [from, to],
          strokeColor: color,
          strokeWidth: 0.18,
        });
      } else {
        points.push({ ...from, color, label: `fixed via · ${route.netId}` });
      }
    }
  }

  return {
    title: `Fixed-via routing hypergraph (${prepared.nodes.length} nodes, ${prepared.edges.length} hyperedges)`,
    lines,
    points,
    rects,
  };
};

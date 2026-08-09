import type { GraphicsObject } from "graphics-debug";
import type { SimpleRouteJson } from "@tscircuit/core";
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
    ccwRotationDegrees?: number;
  },
  margin = 0,
  respectRotation = true,
): RectBounds => {
  const rotationRadians =
    (((respectRotation ? obstacle.ccwRotationDegrees : 0) ?? 0) * Math.PI) /
    180;
  const cosine = Math.abs(Math.cos(rotationRadians));
  const sine = Math.abs(Math.sin(rotationRadians));
  const halfWidth = (cosine * obstacle.width + sine * obstacle.height) / 2;
  const halfHeight = (sine * obstacle.width + cosine * obstacle.height) / 2;
  return {
    minX: obstacle.center.x - halfWidth - margin,
    maxX: obstacle.center.x + halfWidth + margin,
    minY: obstacle.center.y - halfHeight - margin,
    maxY: obstacle.center.y + halfHeight + margin,
  };
};

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

const pointToSegmentDistance = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return pointDistance(point, start);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return pointDistance(point, { x: start.x + t * dx, y: start.y + t * dy });
};

export const segmentDistance = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) => {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
  return Math.min(
    pointToSegmentDistance(firstStart, secondStart, secondEnd),
    pointToSegmentDistance(firstEnd, secondStart, secondEnd),
    pointToSegmentDistance(secondStart, firstStart, firstEnd),
    pointToSegmentDistance(secondEnd, firstStart, firstEnd),
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

export const visualizeSimpleRouteJsonInput = (
  input: SimpleRouteJson,
): GraphicsObject => {
  const rects: NonNullable<GraphicsObject["rects"]> = [
    {
      center: {
        x: (input.bounds.minX + input.bounds.maxX) / 2,
        y: (input.bounds.minY + input.bounds.maxY) / 2,
      },
      width: input.bounds.maxX - input.bounds.minX,
      height: input.bounds.maxY - input.bounds.minY,
      fill: "rgba(255,255,255,0)",
      stroke: "rgba(15,23,42,0.45)",
      label: "routing bounds",
    },
  ];
  const circles: NonNullable<GraphicsObject["circles"]> = [];
  const points: NonNullable<GraphicsObject["points"]> = [];
  const lines: NonNullable<GraphicsObject["lines"]> = [];

  for (const [obstacleIndex, obstacle] of input.obstacles.entries()) {
    if (obstacle.isCopperPour) continue;
    const isPrefabricatedVia =
      obstacle.netIsAssignable === true &&
      obstacle.connectedTo.some((id) => id.startsWith("pcb_via"));
    const label = isPrefabricatedVia
      ? `prefabricated via · ${obstacle.obstacleId ?? obstacleIndex}`
      : `obstacle · ${obstacle.obstacleId ?? obstacle.componentId ?? obstacleIndex}`;
    if (obstacle.shape === "circle") {
      circles.push({
        center: obstacle.center,
        radius: Math.max(obstacle.width, obstacle.height) / 2,
        fill: isPrefabricatedVia
          ? "rgba(14,165,233,0.35)"
          : "rgba(239,68,68,0.22)",
        stroke: isPrefabricatedVia ? "#0284c7" : "#b91c1c",
        label,
      });
    } else {
      rects.push({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
        fill: isPrefabricatedVia
          ? "rgba(14,165,233,0.25)"
          : "rgba(239,68,68,0.16)",
        stroke: isPrefabricatedVia ? "#0284c7" : "#b91c1c",
        label,
      });
    }
  }

  for (const connection of input.connections) {
    const color = netColor(connection.name);
    const [root, ...terminals] = connection.pointsToConnect;
    if (!root) continue;
    points.push({ ...root, color, label: `${connection.name} terminal` });
    for (const terminal of terminals) {
      points.push({
        ...terminal,
        color,
        label: `${connection.name} terminal`,
      });
      lines.push({
        points: [root, terminal],
        strokeColor: color,
        strokeWidth: 0.04,
        strokeDash: [0.15, 0.1],
        label: `${connection.name} unrouted`,
      });
    }
  }

  return {
    coordinateSystem: "cartesian",
    title: `Biscuit-board routing input (${input.connections.length} connections, ${input.obstacles.length} obstacles)`,
    rects,
    circles,
    points,
    lines,
  };
};

export const visualizePreparedProblem = (
  prepared: PreparedBiscuitRoutingProblem,
  routes: Iterable<RoutedConnection> = [],
): GraphicsObject => {
  const lines: NonNullable<GraphicsObject["lines"]> = [];
  const points: NonNullable<GraphicsObject["points"]> = [];
  const rects: NonNullable<GraphicsObject["rects"]> = [];
  const maximumTraceWidth = Math.max(
    prepared.input.minTraceWidth,
    prepared.input.nominalTraceWidth ?? 0,
    ...prepared.demands.map((demand) => demand.width),
  );
  const margin =
    maximumTraceWidth / 2 +
    Math.max(
      prepared.options.gridClearance,
      prepared.input.minTraceToPadEdgeClearance ?? 0,
    );

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

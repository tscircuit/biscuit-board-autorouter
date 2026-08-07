import type { Point, RectBounds } from "./types";

const EPSILON = 1e-7;

export const pointDistance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export const pointsEqual = (a: Point, b: Point, epsilon = EPSILON): boolean =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;

const cross = (a: Point, b: Point, c: Point): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const pointOnSegment = (a: Point, b: Point, point: Point): boolean =>
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
): boolean => {
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
    pointOnSegment(firstStart, firstEnd, secondStart) ||
    pointOnSegment(firstStart, firstEnd, secondEnd) ||
    pointOnSegment(secondStart, secondEnd, firstStart) ||
    pointOnSegment(secondStart, secondEnd, firstEnd)
  );
};

const pointToSegmentDistance = (
  point: Point,
  start: Point,
  end: Point,
): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return pointDistance(point, start);
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return pointDistance(point, {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  });
};

export const segmentDistance = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
): number => {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
  return Math.min(
    pointToSegmentDistance(firstStart, secondStart, secondEnd),
    pointToSegmentDistance(firstEnd, secondStart, secondEnd),
    pointToSegmentDistance(secondStart, firstStart, firstEnd),
    pointToSegmentDistance(secondEnd, firstStart, firstEnd),
  );
};

export const pointStrictlyInsideRect = (
  point: Point,
  rect: RectBounds,
): boolean =>
  point.x > rect.minX + EPSILON &&
  point.x < rect.maxX - EPSILON &&
  point.y > rect.minY + EPSILON &&
  point.y < rect.maxY - EPSILON;

/** Liang-Barsky clipping against the interior of an axis-aligned rectangle. */
export const segmentIntersectsRectInterior = (
  start: Point,
  end: Point,
  rect: RectBounds,
): boolean => {
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
  for (let index = 0; index < 4; index += 1) {
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

export const getRectCorners = (rect: RectBounds): Point[] => [
  { x: rect.minX, y: rect.minY },
  { x: rect.minX, y: rect.maxY },
  { x: rect.maxX, y: rect.minY },
  { x: rect.maxX, y: rect.maxY },
];

export const boundsOverlap = (first: RectBounds, second: RectBounds): boolean =>
  first.minX <= second.maxX &&
  first.maxX >= second.minX &&
  first.minY <= second.maxY &&
  first.maxY >= second.minY;

export const segmentBounds = (
  start: Point,
  end: Point,
  margin = 0,
): RectBounds => ({
  minX: Math.min(start.x, end.x) - margin,
  minY: Math.min(start.y, end.y) - margin,
  maxX: Math.max(start.x, end.x) + margin,
  maxY: Math.max(start.y, end.y) + margin,
});

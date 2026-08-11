import type { SimplifiedPcbTrace } from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { netColor, pointsEqual } from "./geometry";
import {
  getEffectiveTraceClearance,
  getTraceClearanceViolations,
  postProcessBiscuitBoardTraces,
  traceRouteHasClearance,
  traceSegmentsHaveClearance,
} from "./post-process-biscuit-board-traces-solver";
import type {
  BiscuitBoardRoutingSolution,
  PreparedBiscuitRoutingProblem,
} from "./types";

type RoutePoint = SimplifiedPcbTrace["route"][number];
type WirePoint = Extract<RoutePoint, { route_type: "wire" }>;

const EPSILON = 1e-7;
const CHAMFER_SEARCH_STEPS = 16;
const CLEARANCE_SEARCH_STEPS = 4;

const cloneTraces = (traces: SimplifiedPcbTrace[]) =>
  traces.map((trace) => ({
    ...trace,
    route: trace.route.map((point) => ({ ...point })),
  }));

const pointKey = (point: WirePoint) =>
  `${point.layer}:${point.x.toFixed(6)}:${point.y.toFixed(6)}`;

const sameWirePoint = (first: RoutePoint, second: RoutePoint) =>
  first.route_type === "wire" &&
  second.route_type === "wire" &&
  first.layer === second.layer &&
  pointsEqual(first, second);

const wirePathLength = (points: WirePoint[]) =>
  points
    .slice(1)
    .reduce(
      (length, point, index) =>
        length +
        Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y),
      0,
    );

const getWireSegments = (trace: SimplifiedPcbTrace) => {
  const segments: Array<{ start: WirePoint; end: WirePoint }> = [];
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

const getProtectedJunctionKeys = (traces: SimplifiedPcbTrace[]) => {
  const traceIndexesByPoint = new Map<string, Set<number>>();
  for (const [traceIndex, trace] of traces.entries()) {
    for (const point of trace.route) {
      if (point.route_type !== "wire") continue;
      const indexes = traceIndexesByPoint.get(pointKey(point)) ?? new Set();
      indexes.add(traceIndex);
      traceIndexesByPoint.set(pointKey(point), indexes);
    }
  }
  return new Set(
    [...traceIndexesByPoint.entries()]
      .filter(([, traceIndexes]) => traceIndexes.size > 1)
      .map(([key]) => key),
  );
};

const routeGeometryEqual = (
  first: SimplifiedPcbTrace["route"],
  second: SimplifiedPcbTrace["route"],
) =>
  first.length === second.length &&
  first.every((point, index) => {
    const other = second[index]!;
    if (point.route_type === "wire" && other.route_type === "wire") {
      return point.layer === other.layer && pointsEqual(point, other);
    }
    return JSON.stringify(point) === JSON.stringify(other);
  });

const removeConsecutiveDuplicateWirePoints = (
  route: SimplifiedPcbTrace["route"],
) =>
  route.filter((point, index) => {
    if (index === 0) return true;
    return !sameWirePoint(route[index - 1]!, point);
  });

interface ConsolidationCandidate {
  route: SimplifiedPcbTrace["route"];
  overlapLength: number;
  lengthReduction: number;
}

/**
 * Reuses a same-net trace between junctions whenever doing so does not make the
 * route longer. This turns adjacent duplicate branches back into one visible
 * copper path after clearance cleanup has moved them independently.
 */
const consolidateSameNetTraces = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  clearance: number,
) => {
  const traces = cloneTraces(solution.traces);
  const protectedJunctionKeys = getProtectedJunctionKeys(traces);
  let consolidationCount = 0;

  for (let pass = 0; pass < traces.length; pass++) {
    let changed = false;
    for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
      const route = traces[traceIndex]!.route;
      let best: ConsolidationCandidate | null = null;

      for (let anchorIndex = 0; anchorIndex < traces.length; anchorIndex++) {
        if (
          anchorIndex === traceIndex ||
          solution.routes[anchorIndex]!.netId !==
            solution.routes[traceIndex]!.netId
        ) {
          continue;
        }
        const anchorRoute = traces[anchorIndex]!.route;
        const matches: Array<{ routeIndex: number; anchorRouteIndex: number }> =
          [];
        for (const [routeIndex, point] of route.entries()) {
          if (point.route_type !== "wire") continue;
          for (const [anchorRouteIndex, anchorPoint] of anchorRoute.entries()) {
            if (sameWirePoint(point, anchorPoint)) {
              matches.push({ routeIndex, anchorRouteIndex });
            }
          }
        }

        for (let firstIndex = 0; firstIndex < matches.length; firstIndex++) {
          for (
            let secondIndex = firstIndex + 1;
            secondIndex < matches.length;
            secondIndex++
          ) {
            const first = matches[firstIndex]!;
            const second = matches[secondIndex]!;
            if (first.routeIndex >= second.routeIndex) continue;
            const candidateSpan = route.slice(
              first.routeIndex,
              second.routeIndex + 1,
            );
            const anchorSpan =
              first.anchorRouteIndex <= second.anchorRouteIndex
                ? anchorRoute.slice(
                    first.anchorRouteIndex,
                    second.anchorRouteIndex + 1,
                  )
                : anchorRoute
                    .slice(second.anchorRouteIndex, first.anchorRouteIndex + 1)
                    .reverse();
            if (
              candidateSpan.length < 2 ||
              anchorSpan.length < 2 ||
              !candidateSpan.every(
                (point) =>
                  point.route_type === "wire" &&
                  point.layer === (candidateSpan[0] as WirePoint).layer,
              ) ||
              !anchorSpan.every(
                (point) =>
                  point.route_type === "wire" &&
                  point.layer === (anchorSpan[0] as WirePoint).layer,
              )
            ) {
              continue;
            }

            const candidateWireSpan = candidateSpan as WirePoint[];
            const anchorWireSpan = anchorSpan as WirePoint[];
            const candidateLength = wirePathLength(candidateWireSpan);
            const anchorLength = wirePathLength(anchorWireSpan);
            if (anchorLength > candidateLength + EPSILON) continue;

            const width = candidateWireSpan[0]!.width;
            const replacement = anchorWireSpan.map((point) => ({
              ...point,
              width,
            }));
            const removedJunctionKeys = new Set(
              candidateWireSpan
                .slice(1, -1)
                .map(pointKey)
                .filter((key) => protectedJunctionKeys.has(key)),
            );
            if (
              [...removedJunctionKeys].some(
                (key) => !replacement.some((point) => pointKey(point) === key),
              )
            ) {
              continue;
            }

            const candidateRoute = removeConsecutiveDuplicateWirePoints([
              ...route.slice(0, first.routeIndex),
              ...replacement,
              ...route.slice(second.routeIndex + 1),
            ]);
            if (routeGeometryEqual(route, candidateRoute)) continue;
            const workingSolution = { ...solution, traces };
            if (
              !traceRouteHasClearance(
                prepared,
                workingSolution,
                traceIndex,
                candidateRoute,
                clearance,
              )
            ) {
              continue;
            }

            const candidate = {
              route: candidateRoute,
              overlapLength: anchorLength,
              lengthReduction: candidateLength - anchorLength,
            };
            if (
              !best ||
              candidate.overlapLength > best.overlapLength + EPSILON ||
              (Math.abs(candidate.overlapLength - best.overlapLength) <=
                EPSILON &&
                candidate.lengthReduction > best.lengthReduction + EPSILON)
            ) {
              best = candidate;
            }
          }
        }
      }

      if (!best) continue;
      traces[traceIndex] = { ...traces[traceIndex]!, route: best.route };
      consolidationCount++;
      changed = true;
    }
    if (!changed) break;
  }

  return { traces, consolidationCount };
};

const createChamferPoints = (
  route: SimplifiedPcbTrace["route"],
  cornerIndex: number,
  distance: number,
) => {
  const previous = route[cornerIndex - 1] as WirePoint;
  const corner = route[cornerIndex] as WirePoint;
  const next = route[cornerIndex + 1] as WirePoint;
  const incomingLength = Math.hypot(
    previous.x - corner.x,
    previous.y - corner.y,
  );
  const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
  const entry: WirePoint = {
    ...corner,
    x: corner.x + ((previous.x - corner.x) / incomingLength) * distance,
    y: corner.y + ((previous.y - corner.y) / incomingLength) * distance,
  };
  const exit: WirePoint = {
    ...corner,
    x: corner.x + ((next.x - corner.x) / outgoingLength) * distance,
    y: corner.y + ((next.y - corner.y) / outgoingLength) * distance,
  };
  return { entry, exit };
};

const createChamferedRoute = (
  route: SimplifiedPcbTrace["route"],
  cornerIndex: number,
  distance: number,
) => {
  const { entry, exit } = createChamferPoints(route, cornerIndex, distance);
  return removeConsecutiveDuplicateWirePoints([
    ...route.slice(0, cornerIndex),
    entry,
    exit,
    ...route.slice(cornerIndex + 1),
  ]);
};

const createChamferSegments = (
  route: SimplifiedPcbTrace["route"],
  cornerIndex: number,
  distance: number,
) => {
  const previous = route[cornerIndex - 1] as WirePoint;
  const next = route[cornerIndex + 1] as WirePoint;
  const { entry, exit } = createChamferPoints(route, cornerIndex, distance);
  const points = [previous, entry, exit, next].filter(
    (point, index, path) =>
      index === 0 || !pointsEqual(path[index - 1]!, point),
  );
  return points.slice(1).map((end, index) => ({
    start: points[index]!,
    end,
  }));
};

const isManhattanCorner = (
  previous: WirePoint,
  corner: WirePoint,
  next: WirePoint,
) => {
  const incoming = {
    x: previous.x - corner.x,
    y: previous.y - corner.y,
  };
  const outgoing = { x: next.x - corner.x, y: next.y - corner.y };
  const incomingIsAxisAligned =
    Math.abs(incoming.x) <= EPSILON || Math.abs(incoming.y) <= EPSILON;
  const outgoingIsAxisAligned =
    Math.abs(outgoing.x) <= EPSILON || Math.abs(outgoing.y) <= EPSILON;
  const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
  return (
    incomingIsAxisAligned &&
    outgoingIsAxisAligned &&
    Math.abs(dot) <= EPSILON &&
    Math.hypot(incoming.x, incoming.y) > EPSILON &&
    Math.hypot(outgoing.x, outgoing.y) > EPSILON
  );
};

/** Replaces every unprotected 90-degree corner with its largest safe chamfer. */
const chamferTraceCorners = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
  clearance: number,
) => {
  const traces = cloneTraces(solution.traces);
  const protectedJunctionKeys = getProtectedJunctionKeys(traces);
  let chamferCount = 0;

  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    let route = traces[traceIndex]!.route;
    for (let cornerIndex = 1; cornerIndex < route.length - 1; cornerIndex++) {
      const previous = route[cornerIndex - 1]!;
      const corner = route[cornerIndex]!;
      const next = route[cornerIndex + 1]!;
      if (
        previous.route_type !== "wire" ||
        corner.route_type !== "wire" ||
        next.route_type !== "wire" ||
        previous.layer !== corner.layer ||
        corner.layer !== next.layer ||
        protectedJunctionKeys.has(pointKey(corner)) ||
        !isManhattanCorner(previous, corner, next)
      ) {
        continue;
      }

      const maximumDistance = Math.min(
        Math.hypot(previous.x - corner.x, previous.y - corner.y),
        Math.hypot(next.x - corner.x, next.y - corner.y),
      );
      const workingSolution = { ...solution, traces };
      const candidateIsClear = (distance: number) =>
        traceSegmentsHaveClearance(
          prepared,
          workingSolution,
          traceIndex,
          createChamferSegments(route, cornerIndex, distance),
          clearance,
        );

      let bestDistance = 0;
      if (candidateIsClear(maximumDistance)) {
        bestDistance = maximumDistance;
      } else {
        let low = 0;
        let high = maximumDistance;
        for (let step = 0; step < CHAMFER_SEARCH_STEPS; step++) {
          const distance = (low + high) / 2;
          if (candidateIsClear(distance)) low = distance;
          else high = distance;
        }
        bestDistance = low;
      }
      if (bestDistance <= 1e-4) continue;

      route = createChamferedRoute(route, cornerIndex, bestDistance);
      traces[traceIndex] = { ...traces[traceIndex]!, route };
      chamferCount++;
      // The corner is now an entry/exit pair. Advancing once prevents the exit
      // from being reconsidered as part of the same original corner.
      cornerIndex++;
    }
  }

  return { traces, chamferCount };
};

const maximizeClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
) => {
  const minimumClearance = getEffectiveTraceClearance(prepared);
  const desiredClearance =
    minimumClearance +
    Math.min(0.2, Math.max(minimumClearance, prepared.input.minTraceWidth));
  if (desiredClearance <= minimumClearance + EPSILON) {
    return {
      solution,
      clearance: minimumClearance,
      desiredClearance,
    };
  }

  let low = minimumClearance;
  let high = desiredClearance;
  let bestSolution = solution;
  for (let step = 0; step < CLEARANCE_SEARCH_STEPS; step++) {
    const candidateClearance = step === 0 ? high : (low + high) / 2;
    const candidatePrepared = {
      ...prepared,
      options: { ...prepared.options, gridClearance: candidateClearance },
    };
    try {
      bestSolution = postProcessBiscuitBoardTraces(candidatePrepared, solution);
      low = candidateClearance;
      if (Math.abs(low - desiredClearance) <= EPSILON) break;
    } catch {
      high = candidateClearance;
    }
  }
  return { solution: bestSolution, clearance: low, desiredClearance };
};

export const beautifyBiscuitBoardTraces = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
): BiscuitBoardRoutingSolution => {
  const spread = maximizeClearance(prepared, solution);
  const consolidated = consolidateSameNetTraces(
    prepared,
    spread.solution,
    spread.clearance,
  );
  const consolidatedSolution = {
    ...spread.solution,
    traces: consolidated.traces,
  };
  const chamfered = chamferTraceCorners(
    prepared,
    consolidatedSolution,
    spread.desiredClearance,
  );
  const output: BiscuitBoardRoutingSolution = {
    ...consolidatedSolution,
    traces: chamfered.traces,
    stats: {
      ...consolidatedSolution.stats,
      beautifiedClearance: spread.clearance,
      sameNetConsolidationCount: consolidated.consolidationCount,
      fortyFiveDegreeChamferCount: chamfered.chamferCount,
    },
  };
  const violations = getTraceClearanceViolations(
    prepared,
    output,
    spread.clearance,
  );
  if (violations.length > 0) {
    throw new Error(`Trace beautification failed: ${violations[0]!.message}`);
  }
  return output;
};

const visualizeTraces = (
  input: BiscuitBoardRoutingSolution,
  output: BiscuitBoardRoutingSolution,
): GraphicsObject => ({
  coordinateSystem: "cartesian",
  title: `Trace beautification (${output.stats.beautifiedClearance ?? output.stats.postProcessedClearance ?? 0}mm clearance, ${output.stats.sameNetConsolidationCount ?? 0} consolidated spans, ${output.stats.fortyFiveDegreeChamferCount ?? 0} 45-degree corners)`,
  lines: [
    ...input.traces.flatMap((trace) =>
      getWireSegments(trace).map((segment) => ({
        points: [segment.start, segment.end],
        strokeColor: "rgba(100,116,139,0.28)",
        strokeWidth: Math.min(segment.start.width, 0.07),
        strokeDash: [0.12, 0.08],
        label: "pre-beautification trace",
      })),
    ),
    ...output.routes.flatMap((route, traceIndex) =>
      getWireSegments(output.traces[traceIndex]!).map((segment) => ({
        points: [segment.start, segment.end],
        strokeColor: netColor(route.netId),
        strokeWidth: segment.start.width,
        zIndex: 2,
        label: `beautified trace · ${route.netId}`,
      })),
    ),
  ],
});

export class BeautifyBiscuitBoardTracesSolver extends BaseSolver {
  private output?: BiscuitBoardRoutingSolution;

  constructor(
    public readonly params: {
      prepared: PreparedBiscuitRoutingProblem;
      built: BiscuitBoardRoutingSolution;
      enabled?: boolean;
    },
  ) {
    super();
  }

  override getConstructorParams(): [typeof this.params] {
    return [this.params];
  }

  override _step() {
    this.output =
      this.params.enabled === false
        ? this.params.built
        : beautifyBiscuitBoardTraces(this.params.prepared, this.params.built);
    this.stats = this.output.stats;
    this.progress = 1;
    this.solved = true;
  }

  override getOutput() {
    return this.output ?? null;
  }

  override visualize(): GraphicsObject {
    return visualizeTraces(this.params.built, this.output ?? this.params.built);
  }
}

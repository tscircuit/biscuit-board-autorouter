import type { SimplifiedPcbTrace } from "@tscircuit/core";
import {
  ConnectionNameResolver,
  PowerTraceExpanderSolver,
  SpatialObstacleIndex,
} from "@tscircuit/power-trace-expander";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { assertOnlyPrefabricatedVias } from "./build-biscuit-board-traces-solver";
import { getEffectiveTraceClearance } from "./post-process-biscuit-board-traces-solver";
import type {
  BiscuitBoardRoutingSolution,
  PreparedBiscuitRoutingProblem,
} from "./types";

type RoutePoint = SimplifiedPcbTrace["route"][number];
type WirePoint = Extract<RoutePoint, { route_type: "wire" }>;

const WIDTH_EPSILON = 1e-7;
// The route input and Circuit JSON use slightly different representations for
// short diagonal width transitions at pads. Use this only for the final width
// fit so it does not make the expander search a globally over-constrained board.
const EXPANSION_CLEARANCE_GUARD = 0.04;
const FINAL_STATIC_CLEARANCE_GUARD = 0.025;

const getExpansionClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  guard = 0,
) =>
  Math.max(
    prepared.input.defaultObstacleMargin ?? 0,
    getEffectiveTraceClearance(prepared),
  ) + guard;

const pointIsOnSegment = (
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const cross =
    (point.x - start.x) * (end.y - start.y) -
    (point.y - start.y) * (end.x - start.x);
  const dot =
    (point.x - start.x) * (point.x - end.x) +
    (point.y - start.y) * (point.y - end.y);
  return Math.abs(cross) <= WIDTH_EPSILON && dot <= WIDTH_EPSILON;
};

const orientation = (
  start: { x: number; y: number },
  end: { x: number; y: number },
  point: { x: number; y: number },
) =>
  (end.x - start.x) * (point.y - start.y) -
  (end.y - start.y) * (point.x - start.x);

const segmentsIntersect = (
  aStart: { x: number; y: number },
  aEnd: { x: number; y: number },
  bStart: { x: number; y: number },
  bEnd: { x: number; y: number },
) => {
  const a = orientation(aStart, aEnd, bStart);
  const b = orientation(aStart, aEnd, bEnd);
  const c = orientation(bStart, bEnd, aStart);
  const d = orientation(bStart, bEnd, aEnd);
  if (a * b < 0 && c * d < 0) return true;
  return (
    (Math.abs(a) <= WIDTH_EPSILON && pointIsOnSegment(bStart, aStart, aEnd)) ||
    (Math.abs(b) <= WIDTH_EPSILON && pointIsOnSegment(bEnd, aStart, aEnd)) ||
    (Math.abs(c) <= WIDTH_EPSILON && pointIsOnSegment(aStart, bStart, bEnd)) ||
    (Math.abs(d) <= WIDTH_EPSILON && pointIsOnSegment(aEnd, bStart, bEnd))
  );
};

const distancePointToSegment = (
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= WIDTH_EPSILON * WIDTH_EPSILON) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
};

const distanceSegmentToSegment = (
  aStart: { x: number; y: number },
  aEnd: { x: number; y: number },
  bStart: { x: number; y: number },
  bEnd: { x: number; y: number },
) => {
  if (segmentsIntersect(aStart, aEnd, bStart, bEnd)) return 0;
  return Math.min(
    distancePointToSegment(aStart, bStart, bEnd),
    distancePointToSegment(aEnd, bStart, bEnd),
    distancePointToSegment(bStart, aStart, aEnd),
    distancePointToSegment(bEnd, aStart, aEnd),
  );
};

const getObstacleCorners = (
  obstacle: PreparedBiscuitRoutingProblem["input"]["obstacles"][number],
) => {
  const radians = ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = obstacle.width / 2;
  const halfHeight = obstacle.height / 2;
  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((point) => ({
    x: obstacle.center.x + point.x * cos - point.y * sin,
    y: obstacle.center.y + point.x * sin + point.y * cos,
  }));
};

const getStaticObstacleWidthLimit = (
  prepared: PreparedBiscuitRoutingProblem,
  start: WirePoint,
  end: WirePoint,
  connectionNames: string[],
  clearance: number,
  onlyPads = false,
) => {
  const directNames = new Set(connectionNames);
  let widthLimit = Number.POSITIVE_INFINITY;
  for (const obstacle of prepared.input.obstacles) {
    if (!obstacle.layers.includes(start.layer)) continue;
    if (
      onlyPads &&
      !obstacle.connectedTo[0]?.startsWith("pcb_smtpad_") &&
      !obstacle.connectedTo[0]?.startsWith("pcb_plated_hole_")
    ) {
      continue;
    }
    if (obstacle.connectedTo.some((name) => directNames.has(name))) {
      continue;
    }
    const corners = getObstacleCorners(obstacle);
    const centerlineDistance = Math.min(
      ...corners.map((corner, index) =>
        distanceSegmentToSegment(
          start,
          end,
          corner,
          corners[(index + 1) % corners.length]!,
        ),
      ),
    );
    widthLimit = Math.min(widthLimit, 2 * (centerlineDistance - clearance));
  }
  return widthLimit;
};

const segmentCollidesWithStaticObstacle = (
  prepared: PreparedBiscuitRoutingProblem,
  start: WirePoint,
  end: WirePoint,
  width: number,
  connectionNames: string[],
  clearance: number,
) => {
  const widthLimit = getStaticObstacleWidthLimit(
    prepared,
    start,
    end,
    connectionNames,
    clearance,
  );
  return width > widthLimit + WIDTH_EPSILON;
};

const wirePointsAreCollinear = (
  previous: WirePoint,
  current: WirePoint,
  next: WirePoint,
) => {
  if (previous.layer !== current.layer || current.layer !== next.layer) {
    return false;
  }
  const incoming = {
    x: current.x - previous.x,
    y: current.y - previous.y,
  };
  const outgoing = { x: next.x - current.x, y: next.y - current.y };
  const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
  const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
  return Math.abs(cross) <= WIDTH_EPSILON && dot >= 0;
};

const canRemoveCollinearPoint = (
  previous: WirePoint,
  current: WirePoint,
  next: WirePoint,
) => {
  const currentWithPorts = current as WirePoint & {
    start_pcb_port_id?: string;
    end_pcb_port_id?: string;
  };
  if (
    Math.abs(previous.width - current.width) > WIDTH_EPSILON ||
    currentWithPorts.start_pcb_port_id ||
    currentWithPorts.end_pcb_port_id
  ) {
    return false;
  }
  return wirePointsAreCollinear(previous, current, next);
};

/** Remove expansion probe points without changing geometry or segment widths. */
export const compactExpandedTraceRoute = (
  route: SimplifiedPcbTrace["route"],
): SimplifiedPcbTrace["route"] => {
  const compacted: SimplifiedPcbTrace["route"] = [];
  for (const point of route) {
    compacted.push({ ...point });
    while (compacted.length >= 3) {
      const previous = compacted[compacted.length - 3]!;
      const current = compacted[compacted.length - 2]!;
      const next = compacted[compacted.length - 1]!;
      if (
        previous.route_type !== "wire" ||
        current.route_type !== "wire" ||
        next.route_type !== "wire" ||
        !canRemoveCollinearPoint(previous, current, next)
      ) {
        break;
      }
      compacted.splice(compacted.length - 2, 1);
    }
  }
  return compacted;
};

export const assertExpandedTraceClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  traces: SimplifiedPcbTrace[],
  baselineTraces: SimplifiedPcbTrace[] = [],
  guard = 0,
) => {
  const input = {
    ...prepared.input,
    defaultObstacleMargin: getExpansionClearance(prepared, guard),
    traces,
  };
  const connectionNameResolver = new ConnectionNameResolver(input, traces);
  for (const [traceIndex, trace] of traces.entries()) {
    const baselineTrace = baselineTraces.find(
      (candidate) => candidate.pcb_trace_id === trace.pcb_trace_id,
    );
    const traceWithAliases = trace as SimplifiedPcbTrace & {
      source_trace_id?: string;
      rootConnectionName?: string;
      mergedConnectionNames?: string[];
    };
    const obstacleIndex = new SpatialObstacleIndex(
      input,
      traces,
      traceIndex,
      [],
      connectionNameResolver,
    );
    const connectionNames = [
      trace.connection_name,
      traceWithAliases.source_trace_id,
      traceWithAliases.rootConnectionName,
      ...(traceWithAliases.mergedConnectionNames ?? []),
      ...(trace.connectsTo ?? []),
    ].filter((name): name is string => Boolean(name));
    for (
      let routeIndex = 0;
      routeIndex < trace.route.length - 1;
      routeIndex++
    ) {
      const start = trace.route[routeIndex]!;
      const end = trace.route[routeIndex + 1]!;
      if (
        start.route_type !== "wire" ||
        end.route_type !== "wire" ||
        start.layer !== end.layer
      ) {
        continue;
      }
      const collisions = obstacleIndex.findCollisions({
        start,
        end,
        layer: start.layer,
        width: start.width,
        connectionNames,
        ignoreTraceIndex: traceIndex,
      });
      if (collisions.length > 0) {
        const segmentWasAlreadyValidated = baselineTrace?.route.some(
          (baselineStart, baselineIndex) => {
            const baselineEnd = baselineTrace.route[baselineIndex + 1];
            return (
              baselineStart.route_type === "wire" &&
              baselineEnd?.route_type === "wire" &&
              baselineStart.layer === start.layer &&
              baselineEnd.layer === end.layer &&
              pointIsOnSegment(start, baselineStart, baselineEnd) &&
              pointIsOnSegment(end, baselineStart, baselineEnd) &&
              Math.abs(baselineStart.width - start.width) <= WIDTH_EPSILON
            );
          },
        );
        if (segmentWasAlreadyValidated) continue;
        throw new Error(
          `Expanded trace "${trace.pcb_trace_id}" violates copper clearance at segment ${routeIndex} (${collisions[0]!.kind})`,
        );
      }
    }
  }
};

const getBaselineSegmentWidth = (
  trace: SimplifiedPcbTrace | undefined,
  start: WirePoint,
  end: WirePoint,
) => {
  if (!trace) return null;
  for (let index = 0; index < trace.route.length - 1; index++) {
    const baselineStart = trace.route[index]!;
    const baselineEnd = trace.route[index + 1]!;
    if (
      baselineStart.route_type === "wire" &&
      baselineEnd.route_type === "wire" &&
      baselineStart.layer === start.layer &&
      baselineEnd.layer === end.layer &&
      pointIsOnSegment(start, baselineStart, baselineEnd) &&
      pointIsOnSegment(end, baselineStart, baselineEnd)
    ) {
      return baselineStart.width;
    }
  }
  return null;
};

/**
 * Narrow only the individual widened segments that are marginal in the final
 * route representation. Existing physical-width copper remains the fallback.
 */
export const fitExpandedTraceWidthsToClearance = (
  prepared: PreparedBiscuitRoutingProblem,
  traces: SimplifiedPcbTrace[],
  baselineTraces: SimplifiedPcbTrace[],
) => {
  const fitted = traces.map((trace) => ({
    ...trace,
    route: trace.route.map((point) => ({ ...point })),
  }));
  const baseInput = {
    ...prepared.input,
    defaultObstacleMargin: getExpansionClearance(prepared),
    traces: fitted,
  };
  const guardedInput = {
    ...prepared.input,
    defaultObstacleMargin: getExpansionClearance(
      prepared,
      EXPANSION_CLEARANCE_GUARD,
    ),
    traces: fitted,
  };
  // The general resolver intentionally follows every imported alias. For the
  // final width fit, direct SimpleRouteJson connection names are safer: pads
  // carry their assigned source_net name, while net-assignable prefab vias
  // carry every connection they may legally accept.
  const directConnectionNameResolver = {
    canonicalize: (names: string[]) => [...new Set(names)],
  } as ConnectionNameResolver;

  for (const [traceIndex, trace] of fitted.entries()) {
    const baselineTrace = baselineTraces.find(
      (candidate) => candidate.pcb_trace_id === trace.pcb_trace_id,
    );
    const traceWithAliases = trace as SimplifiedPcbTrace & {
      source_trace_id?: string;
      rootConnectionName?: string;
      mergedConnectionNames?: string[];
    };
    const connectionNames = [
      trace.connection_name,
      traceWithAliases.source_trace_id,
      traceWithAliases.rootConnectionName,
      ...(traceWithAliases.mergedConnectionNames ?? []),
      ...(trace.connectsTo ?? []),
    ].filter((name): name is string => Boolean(name));
    const baseObstacleIndex = new SpatialObstacleIndex(
      baseInput,
      fitted,
      traceIndex,
      [],
      directConnectionNameResolver,
    );
    const guardedObstacleIndex = new SpatialObstacleIndex(
      guardedInput,
      fitted,
      traceIndex,
      [],
      directConnectionNameResolver,
    );

    for (
      let routeIndex = 0;
      routeIndex < trace.route.length - 1;
      routeIndex++
    ) {
      const start = trace.route[routeIndex]!;
      const end = trace.route[routeIndex + 1]!;
      if (
        start.route_type !== "wire" ||
        end.route_type !== "wire" ||
        start.layer !== end.layer
      ) {
        continue;
      }
      const previous = trace.route[routeIndex - 1];
      const next = trace.route[routeIndex + 2];
      const hasTinyAdjacentCorner =
        Math.hypot(end.x - start.x, end.y - start.y) <= 0.3 &&
        ((previous?.route_type === "wire" &&
          previous.layer === start.layer &&
          Math.hypot(start.x - previous.x, start.y - previous.y) <= 0.05 &&
          !wirePointsAreCollinear(previous, start, end)) ||
          (next?.route_type === "wire" &&
            next.layer === end.layer &&
            Math.hypot(next.x - end.x, next.y - end.y) <= 0.05 &&
            !wirePointsAreCollinear(start, end, next)));
      const query = {
        start,
        end,
        layer: start.layer,
        connectionNames,
        ignoreTraceIndex: traceIndex,
      };
      const baseClearance = getExpansionClearance(prepared);
      const violatesBaseClearance =
        segmentCollidesWithStaticObstacle(
          prepared,
          start,
          end,
          start.width,
          connectionNames,
          baseClearance,
        ) ||
        baseObstacleIndex.findCollisions({ ...query, width: start.width })
          .length > 0;
      if (!violatesBaseClearance && !hasTinyAdjacentCorner) continue;
      const obstacleIndex = violatesBaseClearance
        ? baseObstacleIndex
        : guardedObstacleIndex;
      const clearance = violatesBaseClearance
        ? baseClearance
        : baseClearance + EXPANSION_CLEARANCE_GUARD;
      const collidesAtWidth = (width: number) =>
        segmentCollidesWithStaticObstacle(
          prepared,
          start,
          end,
          width,
          connectionNames,
          clearance,
        ) ||
        obstacleIndex.findCollisions({
          ...query,
          width,
        }).length > 0;
      if (!collidesAtWidth(start.width)) continue;

      const baselineWidth = getBaselineSegmentWidth(baselineTrace, start, end);
      const minimumWidth = Math.max(
        prepared.input.minTraceWidth,
        baselineWidth ?? prepared.input.minTraceWidth,
      );
      if (start.width <= minimumWidth + WIDTH_EPSILON) continue;

      const widthStep = 0.0125;
      const candidateWidths = Array.from(
        {
          length: Math.ceil((start.width - minimumWidth) / widthStep) + 1,
        },
        (_, index) => Math.max(minimumWidth, start.width - index * widthStep),
      );
      const fittedWidth = candidateWidths.find(
        (width) => !collidesAtWidth(width),
      );
      start.width = fittedWidth ?? minimumWidth;
    }
  }

  // Apply the exact rectangle limit directly as a final deterministic clamp.
  // This covers long shallow pad crossings that may span multiple cells in the
  // expander's spatial approximation.
  for (const trace of fitted) {
    let requiresTraceWidthFallback = trace.route.some((point, routeIndex) => {
      const next = trace.route[routeIndex + 1];
      return (
        point.route_type === "wire" &&
        next?.route_type === "wire" &&
        point.layer === next.layer &&
        Math.hypot(next.x - point.x, next.y - point.y) > 1 &&
        Math.hypot(next.x - point.x, next.y - point.y) < 2 &&
        Math.abs(next.y - point.y) <= 0.05 &&
        next.width < point.width - WIDTH_EPSILON &&
        point.width >
          getStaticObstacleWidthLimit(
            prepared,
            point,
            next,
            [],
            getExpansionClearance(prepared) + FINAL_STATIC_CLEARANCE_GUARD,
            true,
          ) +
            WIDTH_EPSILON
      );
    });
    const baselineTrace = baselineTraces.find(
      (candidate) => candidate.pcb_trace_id === trace.pcb_trace_id,
    );
    const traceWithAliases = trace as SimplifiedPcbTrace & {
      source_trace_id?: string;
      rootConnectionName?: string;
      mergedConnectionNames?: string[];
    };
    const connectionNames = [
      trace.connection_name,
      traceWithAliases.source_trace_id,
      traceWithAliases.rootConnectionName,
      ...(traceWithAliases.mergedConnectionNames ?? []),
      ...(trace.connectsTo ?? []),
    ].filter((name): name is string => Boolean(name));
    for (
      let routeIndex = 0;
      routeIndex < trace.route.length - 1;
      routeIndex++
    ) {
      const start = trace.route[routeIndex]!;
      const end = trace.route[routeIndex + 1]!;
      if (
        start.route_type !== "wire" ||
        end.route_type !== "wire" ||
        start.layer !== end.layer
      ) {
        continue;
      }
      const baselineWidth = getBaselineSegmentWidth(baselineTrace, start, end);
      const minimumWidth = Math.max(
        prepared.input.minTraceWidth,
        baselineWidth ?? prepared.input.minTraceWidth,
      );
      const widthLimit = getStaticObstacleWidthLimit(
        prepared,
        start,
        end,
        connectionNames,
        getExpansionClearance(prepared) + FINAL_STATIC_CLEARANCE_GUARD,
      );
      if (start.width <= widthLimit + WIDTH_EPSILON) continue;
      if (
        Math.hypot(end.x - start.x, end.y - start.y) > 1 &&
        end.width < start.width - WIDTH_EPSILON
      ) {
        requiresTraceWidthFallback = true;
      }
      const roundedLimit =
        Math.floor((widthLimit + WIDTH_EPSILON) / 0.0125) * 0.0125;
      start.width = Math.max(minimumWidth, Math.min(start.width, roundedLimit));
    }
    if (requiresTraceWidthFallback) {
      const baselineWireWidths = baselineTrace?.route.flatMap((point) =>
        point.route_type === "wire" ? [point.width] : [],
      );
      const physicalWidth = Math.max(
        baselineWireWidths && baselineWireWidths.length > 0
          ? Math.min(...baselineWireWidths)
          : prepared.input.minTraceWidth,
        prepared.input.minTraceWidth,
      );
      for (const point of trace.route) {
        if (point.route_type === "wire") {
          point.width = Math.min(point.width, physicalWidth);
        }
      }
    }
  }

  return fitted;
};

export class ExpandBiscuitBoardTracesSolver extends BaseSolver {
  private output?: BiscuitBoardRoutingSolution;
  readonly expander: PowerTraceExpanderSolver;

  constructor(
    public readonly params: {
      prepared: PreparedBiscuitRoutingProblem;
      built: BiscuitBoardRoutingSolution;
      enabled?: boolean;
    },
  ) {
    super();
    const expansionInput = {
      ...params.prepared.input,
      defaultObstacleMargin: getExpansionClearance(params.prepared),
      traces: params.built.traces,
    };
    this.expander = new PowerTraceExpanderSolver(expansionInput, {
      // Biscuit boards may change layers only at their prefabricated vias.
      allowNewVias: false,
    });
    this.activeSubSolver = this.expander;
    this.MAX_ITERATIONS = this.expander.MAX_ITERATIONS + 1;
  }

  override getConstructorParams(): [typeof this.params] {
    return [this.params];
  }

  override _step() {
    if (this.params.enabled === false) {
      this.output = this.params.built;
      this.activeSubSolver = null;
      this.progress = 1;
      this.solved = true;
      return;
    }

    if (!this.expander.solved && !this.expander.failed) {
      this.expander.step();
      this.stats = this.expander.stats;
      this.progress = this.expander.computeProgress();
      return;
    }
    if (this.expander.failed) {
      this.error = this.expander.error ?? "Trace expansion failed";
      this.failed = true;
      this.activeSubSolver = null;
      return;
    }

    const expandedTraces = this.expander.getOutput() as SimplifiedPcbTrace[];
    assertExpandedTraceClearance(
      this.params.prepared,
      expandedTraces,
      this.params.built.traces,
    );
    const compactedTraces = expandedTraces.map((trace) => ({
      ...trace,
      route: compactExpandedTraceRoute(trace.route),
    }));
    const traces = fitExpandedTraceWidthsToClearance(
      this.params.prepared,
      compactedTraces,
      this.params.built.traces,
    );
    assertOnlyPrefabricatedVias(this.params.prepared, traces);
    const output = { ...this.params.built, traces };
    this.output = output;
    this.stats = this.expander.stats;
    this.activeSubSolver = null;
    this.progress = 1;
    this.solved = true;
  }

  override getOutput() {
    return this.output ?? null;
  }

  override visualize(): GraphicsObject {
    return this.expander.visualize();
  }
}

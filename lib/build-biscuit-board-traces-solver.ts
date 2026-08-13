import type { SimplifiedPcbTrace } from "@tscircuit/core";
import {
  distance,
  getSegmentIntersection,
  pointToSegmentDistance,
} from "@tscircuit/math-utils";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { pointsEqual, visualizePreparedProblem } from "./geometry";
import type {
  BiscuitBoardRoutingSolution,
  PreparedBiscuitRoutingProblem,
  RoutedConnection,
} from "./types";

const sanitizeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "_");
const ATTACHMENT_EPSILON = 1e-7;

type RoutePoint = SimplifiedPcbTrace["route"][number];
type WirePoint = Extract<RoutePoint, { route_type: "wire" }>;

interface IndexedWireSegment {
  start: WirePoint;
  end: WirePoint;
  startRouteIndex: number;
  endRouteIndex: number;
}

const getWireSegments = (trace: SimplifiedPcbTrace): IndexedWireSegment[] =>
  trace.route.flatMap((point, index) => {
    const next = trace.route[index + 1];
    return point.route_type === "wire" &&
      next?.route_type === "wire" &&
      point.layer === next.layer &&
      !pointsEqual(point, next)
      ? [
          {
            start: point,
            end: next,
            startRouteIndex: index,
            endRouteIndex: index + 1,
          },
        ]
      : [];
  });

const firstIntersectionAlong = (
  start: WirePoint,
  end: WirePoint,
  targetStart: WirePoint,
  targetEnd: WirePoint,
) => {
  if (start.layer !== targetStart.layer) return null;
  const intersection = getSegmentIntersection(
    start,
    end,
    targetStart,
    targetEnd,
  );
  if (!intersection) return null;
  const routeRatio = distance(start, intersection) / distance(start, end);
  const targetRatio =
    distance(targetStart, intersection) / distance(targetStart, targetEnd);
  if (
    routeRatio <= ATTACHMENT_EPSILON ||
    routeRatio >= 1 - ATTACHMENT_EPSILON ||
    targetRatio <= ATTACHMENT_EPSILON ||
    targetRatio >= 1 - ATTACHMENT_EPSILON
  ) {
    return null;
  }
  return {
    ratio: routeRatio,
    point: {
      ...start,
      ...intersection,
    },
  };
};

const pointIsOnSegment = (point: WirePoint, segment: IndexedWireSegment) => {
  if (point.layer !== segment.start.layer) return false;
  return (
    pointToSegmentDistance(point, segment.start, segment.end) <=
    ATTACHMENT_EPSILON
  );
};

const insertJunction = (
  trace: SimplifiedPcbTrace,
  segment: IndexedWireSegment,
  point: WirePoint,
) => {
  if (pointsEqual(segment.start, point) || pointsEqual(segment.end, point)) {
    return;
  }
  trace.route.splice(segment.endRouteIndex, 0, {
    ...segment.start,
    x: point.x,
    y: point.y,
  });
};

export const attachSameNetTraceBranches = (
  solution: BiscuitBoardRoutingSolution,
): BiscuitBoardRoutingSolution => {
  const traces = solution.traces.map((trace) => ({
    ...trace,
    route: trace.route.map((point) => ({ ...point })),
  }));
  const treeTraceIndexesByNet = new Map<string, number[]>();
  const junctions: Array<{ x: number; y: number; layer: string }> = [];
  let attachmentCount = 0;

  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    const trace = traces[traceIndex]!;
    const netId = solution.routes[traceIndex]!.netId;
    const treeTraceIndexes = treeTraceIndexesByNet.get(netId) ?? [];
    treeTraceIndexesByNet.set(netId, treeTraceIndexes);
    const wires = trace.route.filter(
      (point): point is WirePoint => point.route_type === "wire",
    );
    const first = wires[0];
    const last = wires.at(-1);
    if (!first || !last || treeTraceIndexes.length === 0) {
      treeTraceIndexes.push(traceIndex);
      continue;
    }

    const treeSegments = treeTraceIndexes.flatMap((index) =>
      getWireSegments(traces[index]!).map((segment) => ({
        ...segment,
        traceIndex: index,
      })),
    );
    const firstConnectedTraceIndexes = new Set(
      treeSegments
        .filter((segment) => pointIsOnSegment(first, segment))
        .map((segment) => segment.traceIndex),
    );
    const lastConnectedTraceIndexes = new Set(
      treeSegments
        .filter((segment) => pointIsOnSegment(last, segment))
        .map((segment) => segment.traceIndex),
    );
    const firstIsConnected = firstConnectedTraceIndexes.size > 0;
    const lastIsConnected = lastConnectedTraceIndexes.size > 0;
    if (firstIsConnected === lastIsConnected) {
      treeTraceIndexes.push(traceIndex);
      continue;
    }

    const fromStart = !firstIsConnected;
    const connectedTraceIndexes = firstIsConnected
      ? firstConnectedTraceIndexes
      : lastConnectedTraceIndexes;
    const candidateSegments = getWireSegments(trace);
    const orderedSegments = fromStart
      ? candidateSegments.map((segment) => ({
          segment,
          travelStart: segment.start,
          travelEnd: segment.end,
        }))
      : [...candidateSegments].reverse().map((segment) => ({
          segment,
          travelStart: segment.end,
          travelEnd: segment.start,
        }));
    let attachment:
      | {
          point: WirePoint;
          candidate: IndexedWireSegment;
          anchor: (typeof treeSegments)[number];
        }
      | undefined;
    for (const candidate of orderedSegments) {
      let closest:
        | {
            ratio: number;
            point: WirePoint;
            anchor: (typeof treeSegments)[number];
          }
        | undefined;
      for (const anchor of treeSegments) {
        // If the connected endpoint is already on this same trace, stopping at
        // an earlier crossing merely moves that existing attachment point.
        if (connectedTraceIndexes.has(anchor.traceIndex)) continue;
        // Routes that declare a shared terminal are already connected there.
        // Their geometric crossing is not a new tree attachment opportunity.
        if (
          trace.connectsTo?.some((id) =>
            traces[anchor.traceIndex]!.connectsTo?.includes(id),
          )
        ) {
          continue;
        }
        const intersection = firstIntersectionAlong(
          candidate.travelStart,
          candidate.travelEnd,
          anchor.start,
          anchor.end,
        );
        if (!intersection || (closest && intersection.ratio >= closest.ratio)) {
          continue;
        }
        closest = { ...intersection, anchor };
      }
      if (!closest) continue;
      attachment = {
        point: closest.point,
        candidate: candidate.segment,
        anchor: closest.anchor,
      };
      break;
    }
    if (!attachment) {
      treeTraceIndexes.push(traceIndex);
      continue;
    }
    const discardedRoute = fromStart
      ? trace.route.slice(attachment.candidate.endRouteIndex)
      : trace.route.slice(0, attachment.candidate.startRouteIndex + 1);
    if (
      discardedRoute.some((point) => point.route_type === "through_obstacle")
    ) {
      treeTraceIndexes.push(traceIndex);
      continue;
    }

    if (fromStart) {
      trace.route = [
        ...trace.route.slice(0, attachment.candidate.startRouteIndex + 1),
        attachment.point,
      ];
    } else {
      trace.route = [
        attachment.point,
        ...trace.route.slice(attachment.candidate.endRouteIndex),
      ];
    }
    trace.route = trace.route.filter(
      (point, index, route) =>
        index === 0 ||
        point.route_type !== "wire" ||
        route[index - 1]!.route_type !== "wire" ||
        !pointsEqual(point, route[index - 1] as WirePoint),
    );
    insertJunction(
      traces[attachment.anchor.traceIndex]!,
      attachment.anchor,
      attachment.point,
    );
    junctions.push({
      x: attachment.point.x,
      y: attachment.point.y,
      layer: attachment.point.layer,
    });
    treeTraceIndexes.push(traceIndex);
    attachmentCount++;
  }

  return {
    ...solution,
    traces,
    ...(junctions.length > 0 ? { sameNetTreeJunctions: junctions } : {}),
    stats: {
      ...solution.stats,
      ...(attachmentCount > 0
        ? { sameNetTreeAttachmentCount: attachmentCount }
        : {}),
    },
  };
};

const expandSharedNetRoute = (
  prepared: PreparedBiscuitRoutingProblem,
  routes: RoutedConnection[],
  route: RoutedConnection,
): RoutedConnection => {
  const demand = prepared.demandById.get(route.routeId)!;
  if (route.nodePath.length !== 1 || demand.sourceNode === demand.targetNode) {
    return route;
  }

  const adjacency = new Map<
    number,
    Array<{ nodeIndex: number; edgeId: number }>
  >();
  const addEdge = (from: number, to: number, edgeId: number) => {
    const neighbors = adjacency.get(from) ?? [];
    neighbors.push({ nodeIndex: to, edgeId });
    adjacency.set(from, neighbors);
  };
  for (const candidate of routes) {
    if (
      candidate.netId !== route.netId ||
      candidate.routeId === route.routeId
    ) {
      continue;
    }
    for (let index = 1; index < candidate.nodePath.length; index++) {
      const from = candidate.nodePath[index - 1]!;
      const to = candidate.nodePath[index]!;
      const edgeId = candidate.edgePath[index - 1]!;
      addEdge(from, to, edgeId);
      addEdge(to, from, edgeId);
    }
  }

  const previous = new Map<number, { nodeIndex: number; edgeId: number }>();
  const queue = [demand.sourceNode];
  previous.set(demand.sourceNode, {
    nodeIndex: demand.sourceNode,
    edgeId: -1,
  });
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const current = queue[queueIndex]!;
    if (current === demand.targetNode) break;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (previous.has(neighbor.nodeIndex)) continue;
      previous.set(neighbor.nodeIndex, {
        nodeIndex: current,
        edgeId: neighbor.edgeId,
      });
      queue.push(neighbor.nodeIndex);
    }
  }
  if (!previous.has(demand.targetNode)) return route;

  const nodePath = [demand.targetNode];
  const edgePath: number[] = [];
  while (nodePath[0] !== demand.sourceNode) {
    const entry = previous.get(nodePath[0]!)!;
    nodePath.unshift(entry.nodeIndex);
    edgePath.unshift(entry.edgeId);
  }
  return { ...route, nodePath, edgePath };
};

const collapseCollinearNodes = (
  prepared: PreparedBiscuitRoutingProblem,
  nodePath: number[],
  protectedNodeIndexes: ReadonlySet<number>,
) => {
  if (nodePath.length <= 2) return [...nodePath];
  const result = [nodePath[0]!];
  for (let index = 1; index < nodePath.length - 1; index++) {
    const previous = prepared.nodes[result[result.length - 1]!]!;
    const current = prepared.nodes[nodePath[index]!]!;
    const next = prepared.nodes[nodePath[index + 1]!]!;
    const cross =
      (current.x - previous.x) * (next.y - current.y) -
      (current.y - previous.y) * (next.x - current.x);
    if (
      !protectedNodeIndexes.has(nodePath[index]!) &&
      previous.layer === current.layer &&
      current.layer === next.layer &&
      Math.abs(cross) <= 1e-8
    ) {
      continue;
    }
    result.push(nodePath[index]!);
  }
  result.push(nodePath[nodePath.length - 1]!);
  return result;
};

const routeToTrace = (
  prepared: PreparedBiscuitRoutingProblem,
  route: RoutedConnection,
  protectedNodeIndexes: ReadonlySet<number>,
): SimplifiedPcbTrace => {
  const demand = prepared.demandById.get(route.routeId)!;
  const usedPrefabViaIds = [
    ...route.edgePath.flatMap((edgeId) => {
      const edge = prepared.edges[edgeId]!;
      return edge.kind === "fixed_via_transition" ? [edge.prefabViaId] : [];
    }),
    ...route.nodePath.flatMap((nodeIndex) => {
      const prefabViaId = prepared.nodes[nodeIndex]!.prefabViaId;
      return prefabViaId ? [prefabViaId] : [];
    }),
  ];
  const nodePath = collapseCollinearNodes(
    prepared,
    route.nodePath,
    protectedNodeIndexes,
  );
  const outputRoute: SimplifiedPcbTrace["route"] = [];

  for (let index = 0; index < nodePath.length; index++) {
    const node = prepared.nodes[nodePath[index]!]!;
    const previous = index > 0 ? prepared.nodes[nodePath[index - 1]!]! : null;
    if (previous && previous.layer !== node.layer) {
      const via = prepared.prefabricatedVias.find(
        (candidate) =>
          pointsEqual(candidate, node) &&
          candidate.layers.includes(previous.layer) &&
          candidate.layers.includes(node.layer),
      );
      if (!via) {
        throw new Error(
          `Refusing to emit a new via at (${node.x}, ${node.y}) for "${route.routeId}"`,
        );
      }
      outputRoute.push({
        route_type: "through_obstacle",
        start: { x: via.x, y: via.y },
        end: { x: via.x, y: via.y },
        from_layer: previous.layer,
        to_layer: node.layer,
        width: demand.width,
      });
    }
    outputRoute.push({
      route_type: "wire",
      x: node.x,
      y: node.y,
      width: demand.width,
      layer: node.layer,
    });
  }

  return {
    type: "pcb_trace",
    pcb_trace_id: `pcb_trace_${sanitizeId(route.routeId)}`,
    connection_name: route.connectionName,
    connectsTo: [
      ...new Set(
        [
          demand.sourcePointId,
          demand.targetPointId,
          ...usedPrefabViaIds,
        ].filter((pointId): pointId is string => Boolean(pointId)),
      ),
    ],
    route: outputRoute,
  };
};

export const assertOnlyPrefabricatedVias = (
  prepared: PreparedBiscuitRoutingProblem,
  traces: SimplifiedPcbTrace[],
) => {
  for (const trace of traces) {
    for (const routePoint of trace.route) {
      if (routePoint.route_type === "via") {
        throw new Error(
          `Trace "${trace.pcb_trace_id}" contains a manufactured via at (${routePoint.x}, ${routePoint.y})`,
        );
      }
      if (routePoint.route_type !== "through_obstacle") continue;
      const matchingVia = prepared.prefabricatedVias.find(
        (via) =>
          pointsEqual(via, routePoint.start) &&
          pointsEqual(via, routePoint.end) &&
          via.layers.includes(routePoint.from_layer) &&
          via.layers.includes(routePoint.to_layer),
      );
      if (!matchingVia) {
        throw new Error(
          `Trace "${trace.pcb_trace_id}" traverses a non-prefabricated obstacle at (${routePoint.start.x}, ${routePoint.start.y})`,
        );
      }
    }
  }
};

export class BuildBiscuitBoardTracesSolver extends BaseSolver {
  private output?: BiscuitBoardRoutingSolution;
  readonly prepared: PreparedBiscuitRoutingProblem;
  readonly routed: BiscuitBoardRoutingSolution;

  constructor(
    public readonly params: {
      prepared: PreparedBiscuitRoutingProblem;
      routed: BiscuitBoardRoutingSolution;
    },
  ) {
    super();
    this.prepared = params.prepared;
    this.routed = params.routed;
  }

  override getConstructorParams(): [typeof this.params] {
    return [this.params];
  }

  override _step() {
    const protectedNodeIndexes = new Set<number>();
    for (const route of this.routed.routes) {
      const demand = this.prepared.demandById.get(route.routeId)!;
      for (const endpointNode of [route.nodePath[0], route.nodePath.at(-1)]) {
        if (
          endpointNode !== undefined &&
          endpointNode !== demand.sourceNode &&
          endpointNode !== demand.targetNode
        ) {
          protectedNodeIndexes.add(endpointNode);
        }
      }
    }
    const traces = this.routed.routes.map((route) =>
      routeToTrace(
        this.prepared,
        expandSharedNetRoute(this.prepared, this.routed.routes, route),
        protectedNodeIndexes,
      ),
    );
    assertOnlyPrefabricatedVias(this.prepared, traces);
    this.output = attachSameNetTraceBranches({
      ...this.routed,
      traces,
    });
    this.stats = this.output.stats;
    this.progress = 1;
    this.solved = true;
  }

  override getOutput() {
    return this.output ?? null;
  }

  override visualize(): GraphicsObject {
    return {
      ...visualizePreparedProblem(this.prepared, this.routed.routes),
      title: `Built and validated traces (${this.routed.routes.length} routes, ${this.output?.traces.length ?? 0} Circuit JSON traces)`,
    };
  }
}

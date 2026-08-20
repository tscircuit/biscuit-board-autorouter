import type { SimplifiedPcbTrace } from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { assertOnlyPrefabricatedVias } from "./build-biscuit-board-traces-solver";
import { netColor, visualizeSimpleRouteJsonInput } from "./geometry";
import { getTraceClearanceViolations } from "./post-process-biscuit-board-traces-solver";
import type {
  BiscuitBoardRoutingSolution,
  PreparedBiscuitRoutingProblem,
  RouteDemand,
} from "./types";

type RoutePoint = SimplifiedPcbTrace["route"][number];
type WirePoint = Extract<RoutePoint, { route_type: "wire" }>;
type CopperVertexId = string;
type CopperEdgeId = string;
type PrefabricatedViaId = string;
type NetId = string;
type LayerName = string;

interface CopperVertex {
  key: CopperVertexId;
  x: number;
  y: number;
  layer: LayerName;
}

interface CopperEdge {
  key: CopperEdgeId;
  first: CopperVertexId;
  second: CopperVertexId;
  cost: number;
  kind: "wire" | "fixed_via";
  prefabViaId?: PrefabricatedViaId;
}

interface RawWireSegment {
  start: WirePoint;
  end: WirePoint;
  splitRatios: number[];
}

interface CopperGraph {
  vertices: Map<CopperVertexId, CopperVertex>;
  edges: Map<CopperEdgeId, CopperEdge>;
  adjacency: Map<CopperVertexId, CopperEdge[]>;
}

const EPSILON = 1e-7;
const KEY_PRECISION = 7;

const coordinateKey = (value: number) =>
  Math.abs(value) <= EPSILON ? "0" : value.toFixed(KEY_PRECISION);

const vertexKey = (point: {
  x: number;
  y: number;
  layer: LayerName;
}): CopperVertexId =>
  `${point.layer}:${coordinateKey(point.x)}:${coordinateKey(point.y)}`;

const edgeKey = (
  first: CopperVertexId,
  second: CopperVertexId,
  kind: CopperEdge["kind"],
): CopperEdgeId =>
  first < second ? `${kind}:${first}|${second}` : `${kind}:${second}|${first}`;

const cross = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) => first.x * second.y - first.y * second.x;

const subtract = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) => ({ x: first.x - second.x, y: first.y - second.y });

const interpolate = (segment: RawWireSegment, ratio: number) => ({
  x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
  y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
  layer: segment.start.layer,
});

const parameterOnSegment = (
  point: { x: number; y: number },
  segment: RawWireSegment,
) => {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return Math.abs(dx) <= EPSILON ? 0 : (point.x - segment.start.x) / dx;
  }
  return Math.abs(dy) <= EPSILON ? 0 : (point.y - segment.start.y) / dy;
};

const pointIsOnSegment = (
  point: { x: number; y: number; layer: LayerName },
  segment: RawWireSegment,
) => {
  if (point.layer !== segment.start.layer) return false;
  const vector = subtract(segment.end, segment.start);
  const toPoint = subtract(point, segment.start);
  if (Math.abs(cross(vector, toPoint)) > EPSILON) return false;
  const ratio = parameterOnSegment(point, segment);
  return ratio >= -EPSILON && ratio <= 1 + EPSILON;
};

const getTraceEndpoints = (trace: SimplifiedPcbTrace) => {
  const wires = trace.route.filter(
    (point): point is WirePoint => point.route_type === "wire",
  );
  return wires.length === 0 ? [] : [wires[0]!, wires.at(-1)!];
};

const getDemandTerminalKeys = ({
  prepared,
  solution,
  traceIndex,
}: {
  prepared: PreparedBiscuitRoutingProblem;
  solution: BiscuitBoardRoutingSolution;
  traceIndex: number;
}) => {
  const demand = prepared.demandById.get(solution.routes[traceIndex]!.routeId)!;
  return [
    vertexKey(prepared.nodes[demand.sourceNode]!),
    vertexKey(prepared.nodes[demand.targetNode]!),
  ] as const;
};

const addSplitRatio = (segment: RawWireSegment, ratio: number) => {
  if (ratio < -EPSILON || ratio > 1 + EPSILON) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  if (
    !segment.splitRatios.some(
      (existing) => Math.abs(existing - clamped) <= EPSILON,
    )
  ) {
    segment.splitRatios.push(clamped);
  }
};

const splitSegmentsAtIntersection = (
  first: RawWireSegment,
  second: RawWireSegment,
) => {
  if (first.start.layer !== second.start.layer) return;
  const firstVector = subtract(first.end, first.start);
  const secondVector = subtract(second.end, second.start);
  const betweenStarts = subtract(second.start, first.start);
  const denominator = cross(firstVector, secondVector);

  if (Math.abs(denominator) > EPSILON) {
    const firstRatio = cross(betweenStarts, secondVector) / denominator;
    const secondRatio = cross(betweenStarts, firstVector) / denominator;
    if (
      firstRatio >= -EPSILON &&
      firstRatio <= 1 + EPSILON &&
      secondRatio >= -EPSILON &&
      secondRatio <= 1 + EPSILON
    ) {
      addSplitRatio(first, firstRatio);
      addSplitRatio(second, secondRatio);
    }
    return;
  }

  if (Math.abs(cross(betweenStarts, firstVector)) > EPSILON) return;
  for (const endpoint of [first.start, first.end]) {
    const ratio = parameterOnSegment(endpoint, second);
    if (ratio >= -EPSILON && ratio <= 1 + EPSILON) {
      addSplitRatio(second, ratio);
      addSplitRatio(
        first,
        parameterOnSegment(interpolate(second, ratio), first),
      );
    }
  }
  for (const endpoint of [second.start, second.end]) {
    const ratio = parameterOnSegment(endpoint, first);
    if (ratio >= -EPSILON && ratio <= 1 + EPSILON) {
      addSplitRatio(first, ratio);
      addSplitRatio(
        second,
        parameterOnSegment(interpolate(first, ratio), second),
      );
    }
  }
};

const addVertex = (graph: CopperGraph, point: CopperVertex) => {
  if (!graph.vertices.has(point.key)) graph.vertices.set(point.key, point);
};

const addEdge = (graph: CopperGraph, edge: CopperEdge) => {
  if (edge.first === edge.second || graph.edges.has(edge.key)) return;
  graph.edges.set(edge.key, edge);
};

const finishGraph = (graph: CopperGraph) => {
  for (const key of graph.vertices.keys()) graph.adjacency.set(key, []);
  for (const edge of graph.edges.values()) {
    graph.adjacency.get(edge.first)!.push(edge);
    graph.adjacency.get(edge.second)!.push(edge);
  }
  for (const edges of graph.adjacency.values()) {
    edges.sort((first, second) => first.key.localeCompare(second.key));
  }
};

const buildCopperGraph = (
  prepared: PreparedBiscuitRoutingProblem,
  traces: SimplifiedPcbTrace[],
): CopperGraph => {
  const graph: CopperGraph = {
    vertices: new Map(),
    edges: new Map(),
    adjacency: new Map(),
  };
  const segments: RawWireSegment[] = [];

  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    const trace = traces[traceIndex]!;
    for (let index = 0; index < trace.route.length; index++) {
      const point = trace.route[index]!;
      const next = trace.route[index + 1];
      if (
        point.route_type === "wire" &&
        next?.route_type === "wire" &&
        point.layer === next.layer &&
        Math.hypot(point.x - next.x, point.y - next.y) > EPSILON
      ) {
        segments.push({
          start: point,
          end: next,
          splitRatios: [0, 1],
        });
      }
      if (point.route_type !== "through_obstacle") continue;
      const first = {
        key: vertexKey({ ...point.start, layer: point.from_layer }),
        ...point.start,
        layer: point.from_layer,
      };
      const second = {
        key: vertexKey({ ...point.end, layer: point.to_layer }),
        ...point.end,
        layer: point.to_layer,
      };
      const prefabVia = prepared.prefabricatedVias.find(
        (via) =>
          Math.hypot(via.x - point.start.x, via.y - point.start.y) <= EPSILON &&
          Math.hypot(via.x - point.end.x, via.y - point.end.y) <= EPSILON &&
          via.layers.includes(point.from_layer) &&
          via.layers.includes(point.to_layer),
      );
      if (!prefabVia) {
        throw new Error(
          `Cannot planarize non-prefabricated via at (${point.start.x}, ${point.start.y})`,
        );
      }
      addVertex(graph, first);
      addVertex(graph, second);
      const key = edgeKey(first.key, second.key, "fixed_via");
      addEdge(graph, {
        key,
        first: first.key,
        second: second.key,
        cost: prepared.options.viaTransitionCost,
        kind: "fixed_via",
        prefabViaId: prefabVia.prefabViaId,
      });
    }
  }

  // A routed demand may terminate on an existing same-net tree or at the edge
  // of a connected pad rather than at its abstract graph terminal. Preserve
  // the actual emitted trace attachments, splitting a crossed segment when an
  // attachment lies in its interior.
  const traceEndpoints = traces.flatMap(getTraceEndpoints);
  for (const endpoint of traceEndpoints) {
    addVertex(graph, { key: vertexKey(endpoint), ...endpoint });
    for (const segment of segments) {
      if (pointIsOnSegment(endpoint, segment)) {
        addSplitRatio(segment, parameterOnSegment(endpoint, segment));
      }
    }
  }

  for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < segments.length;
      secondIndex++
    ) {
      splitSegmentsAtIntersection(
        segments[firstIndex]!,
        segments[secondIndex]!,
      );
    }
  }

  for (const segment of segments) {
    segment.splitRatios.sort((first, second) => first - second);
    for (let index = 0; index < segment.splitRatios.length - 1; index++) {
      const firstPoint = interpolate(segment, segment.splitRatios[index]!);
      const secondPoint = interpolate(segment, segment.splitRatios[index + 1]!);
      const first = { key: vertexKey(firstPoint), ...firstPoint };
      const second = { key: vertexKey(secondPoint), ...secondPoint };
      addVertex(graph, first);
      addVertex(graph, second);
      const key = edgeKey(first.key, second.key, "wire");
      addEdge(graph, {
        key,
        first: first.key,
        second: second.key,
        cost: Math.hypot(first.x - second.x, first.y - second.y),
        kind: "wire",
      });
    }
  }
  finishGraph(graph);
  return graph;
};

const graphHasCycle = (graph: CopperGraph) => {
  const parent = new Map<CopperVertexId, CopperVertexId>();
  const find = (key: CopperVertexId): CopperVertexId => {
    const current = parent.get(key) ?? key;
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  for (const key of graph.vertices.keys()) parent.set(key, key);
  for (const edge of graph.edges.values()) {
    const firstRoot = find(edge.first);
    const secondRoot = find(edge.second);
    if (firstRoot === secondRoot) return true;
    parent.set(secondRoot, firstRoot);
  }
  return false;
};

const otherEnd = (edge: CopperEdge, vertex: CopperVertexId) =>
  edge.first === vertex ? edge.second : edge.first;

const selectTerminalTree = (
  graph: CopperGraph,
  terminalKeys: CopperVertexId[],
) => {
  const terminals = new Set(terminalKeys);
  for (const terminal of terminals) {
    if (!graph.vertices.has(terminal)) {
      throw new Error(
        `Same-net copper graph does not contain terminal ${terminal}`,
      );
    }
  }
  const parent = new Map<CopperVertexId, CopperVertexId>(
    [...graph.vertices.keys()].map((key) => [key, key]),
  );
  const find = (key: CopperVertexId): CopperVertexId => {
    const current = parent.get(key)!;
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const selectedEdges = new Set<CopperEdgeId>();
  for (const edge of [...graph.edges.values()].sort(
    (first, second) =>
      first.cost - second.cost || first.key.localeCompare(second.key),
  )) {
    const firstRoot = find(edge.first);
    const secondRoot = find(edge.second);
    if (firstRoot !== secondRoot) {
      parent.set(secondRoot, firstRoot);
      selectedEdges.add(edge.key);
    }
  }

  // Kruskal spans every geometric subdivision point. Remove leaves that are
  // not actual trace attachments so remnants of a deleted cycle disappear.
  const degree = new Map<CopperVertexId, number>();
  const queue: CopperVertexId[] = [];
  for (const edgeKey of selectedEdges) {
    const edge = graph.edges.get(edgeKey)!;
    degree.set(edge.first, (degree.get(edge.first) ?? 0) + 1);
    degree.set(edge.second, (degree.get(edge.second) ?? 0) + 1);
  }
  for (const [vertex, count] of degree) {
    if (count <= 1 && !terminals.has(vertex)) queue.push(vertex);
  }
  for (let index = 0; index < queue.length; index++) {
    const vertex = queue[index]!;
    const edge = (graph.adjacency.get(vertex) ?? []).find((candidate) =>
      selectedEdges.has(candidate.key),
    );
    if (!edge) continue;
    selectedEdges.delete(edge.key);
    const neighbor = otherEnd(edge, vertex);
    degree.set(vertex, 0);
    degree.set(neighbor, degree.get(neighbor)! - 1);
    if (degree.get(neighbor) === 1 && !terminals.has(neighbor)) {
      queue.push(neighbor);
    }
  }
  return selectedEdges;
};

const findTreePath = (
  graph: CopperGraph,
  selectedEdges: Set<CopperEdgeId>,
  source: CopperVertexId,
  target: CopperVertexId,
) => {
  const queue = [source];
  const previous = new Map<
    CopperVertexId,
    { vertex: CopperVertexId; edge: CopperEdge }
  >();
  const visited = new Set([source]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) break;
    for (const edge of graph.adjacency.get(current) ?? []) {
      if (!selectedEdges.has(edge.key)) continue;
      const neighbor = otherEnd(edge, current);
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      previous.set(neighbor, { vertex: current, edge });
      queue.push(neighbor);
    }
  }
  if (!visited.has(target)) {
    throw new Error(
      `No selected same-net path connects ${source} to ${target}`,
    );
  }
  const reversed: Array<{
    from: CopperVertexId;
    to: CopperVertexId;
    edge: CopperEdge;
  }> = [];
  let current = target;
  while (current !== source) {
    const step = previous.get(current)!;
    reversed.push({ from: step.vertex, to: current, edge: step.edge });
    current = step.vertex;
  }
  return reversed.reverse();
};

const pathToTrace = (
  prepared: PreparedBiscuitRoutingProblem,
  demand: RouteDemand,
  original: SimplifiedPcbTrace,
  graph: CopperGraph,
  path: ReturnType<typeof findTreePath>,
  sourceKey: CopperVertexId,
): SimplifiedPcbTrace => {
  const route: SimplifiedPcbTrace["route"] = [];
  const usedViaIds = new Set<PrefabricatedViaId>();
  const pushWire = (vertex: CopperVertex) => {
    const previous = route.at(-1);
    if (
      previous?.route_type === "wire" &&
      previous.layer === vertex.layer &&
      Math.hypot(previous.x - vertex.x, previous.y - vertex.y) <= EPSILON
    ) {
      return;
    }
    route.push({
      route_type: "wire",
      x: vertex.x,
      y: vertex.y,
      width: demand.width,
      layer: vertex.layer,
    });
  };

  if (path.length === 0) {
    pushWire(graph.vertices.get(sourceKey)!);
  }
  for (const step of path) {
    const from = graph.vertices.get(step.from)!;
    const to = graph.vertices.get(step.to)!;
    pushWire(from);
    if (step.edge.kind === "fixed_via") {
      route.push({
        route_type: "through_obstacle",
        start: { x: from.x, y: from.y },
        end: { x: to.x, y: to.y },
        from_layer: from.layer,
        to_layer: to.layer,
        width: demand.width,
      });
      usedViaIds.add(step.edge.prefabViaId!);
    }
    pushWire(to);
  }

  return {
    ...original,
    connectsTo: [
      ...new Set([
        ...[demand.sourcePointId, demand.targetPointId].filter(
          (id): id is string => Boolean(id),
        ),
        ...usedViaIds,
      ]),
    ],
    route,
  };
};

export const pruneRedundantSameNetCopper = (
  prepared: PreparedBiscuitRoutingProblem,
  solution: BiscuitBoardRoutingSolution,
): BiscuitBoardRoutingSolution => {
  const traces = [...solution.traces];
  let cycleCount = 0;
  let skippedCycleCount = 0;
  let prunedEdgeCount = 0;
  const routeIndexesByNet = new Map<NetId, number[]>();
  for (let index = 0; index < solution.routes.length; index++) {
    const indexes = routeIndexesByNet.get(solution.routes[index]!.netId) ?? [];
    indexes.push(index);
    routeIndexesByNet.set(solution.routes[index]!.netId, indexes);
  }

  for (const indexes of routeIndexesByNet.values()) {
    const graph = buildCopperGraph(
      prepared,
      indexes.map((index) => solution.traces[index]!),
    );
    if (!graphHasCycle(graph)) continue;
    const terminalKeys = indexes.flatMap((traceIndex) =>
      getDemandTerminalKeys({ prepared, solution, traceIndex }),
    );
    const selectedEdges = selectTerminalTree(graph, terminalKeys);
    const originalNetTraces = indexes.map((index) => traces[index]!);

    for (
      let netTraceIndex = 0;
      netTraceIndex < indexes.length;
      netTraceIndex++
    ) {
      const traceIndex = indexes[netTraceIndex]!;
      const demand = prepared.demandById.get(
        solution.routes[traceIndex]!.routeId,
      )!;
      const [source, target] = getDemandTerminalKeys({
        prepared,
        solution,
        traceIndex,
      });
      traces[traceIndex] = pathToTrace(
        prepared,
        demand,
        solution.traces[traceIndex]!,
        graph,
        findTreePath(graph, selectedEdges, source, target),
        source,
      );
    }

    const candidate = { ...solution, traces };
    if (getTraceClearanceViolations(prepared, candidate).length > 0) {
      for (let index = 0; index < indexes.length; index++) {
        traces[indexes[index]!] = originalNetTraces[index]!;
      }
      skippedCycleCount++;
      continue;
    }
    cycleCount++;
    prunedEdgeCount += graph.edges.size - selectedEdges.size;
  }

  assertOnlyPrefabricatedVias(prepared, traces);
  return {
    ...solution,
    traces,
    stats: {
      ...solution.stats,
      sameNetCyclePruneCount: cycleCount,
      sameNetCyclePruneSkipCount: skippedCycleCount,
      prunedSameNetEdgeCount: prunedEdgeCount,
    },
  };
};

export class PruneRedundantSameNetCopperSolver extends BaseSolver {
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
    this.output = pruneRedundantSameNetCopper(
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
    const output = this.output ?? this.params.built;
    const board = visualizeSimpleRouteJsonInput(this.params.prepared.input);
    return {
      ...board,
      title: `Same-net topology cleanup (${output.stats.sameNetCyclePruneCount ?? 0} cyclic nets pruned, ${output.stats.sameNetCyclePruneSkipCount ?? 0} skipped, ${output.stats.prunedSameNetEdgeCount ?? 0} redundant edges removed)`,
      lines: [
        ...(board.lines ?? []),
        ...output.routes.flatMap((route, traceIndex) => {
          const trace = output.traces[traceIndex]!;
          return trace.route.flatMap((point, pointIndex) => {
            const next = trace.route[pointIndex + 1];
            return point.route_type === "wire" &&
              next?.route_type === "wire" &&
              point.layer === next.layer
              ? [
                  {
                    points: [point, next],
                    strokeColor: netColor(route.netId),
                    strokeWidth: point.width,
                    strokeDash: point.layer === "bottom" ? [6, 4] : undefined,
                    label: `cycle-pruned trace · ${route.netId}`,
                  },
                ]
              : [];
          });
        }),
      ],
    };
  }
}

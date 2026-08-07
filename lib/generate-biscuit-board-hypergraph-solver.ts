import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import {
  obstacleBounds,
  pointDistance,
  pointStrictlyInsideRect,
  pointsEqual,
  segmentDistance,
  segmentIntersectsRectInterior,
  visualizePreparedProblem,
} from "./geometry";
import type {
  BiscuitBoardAutorouterOptions,
  NormalizedBiscuitBoardAutorouterOptions,
  Point,
  PrefabricatedVia,
  PreparedBiscuitRoutingProblem,
  RouteDemand,
  RoutingEdge,
  RoutingNode,
} from "./types";
import type { SimpleRouteJson } from "@tscircuit/core";

const ROUNDING_SCALE = 1e6;
const roundCoordinate = (value: number) =>
  Math.round(value * ROUNDING_SCALE) / ROUNDING_SCALE;
const coordinateKey = (value: number) => roundCoordinate(value).toFixed(6);
const nodeKey = (layer: string, x: number, y: number) =>
  `${layer}:${coordinateKey(x)}:${coordinateKey(y)}`;

const DEFAULT_OPTIONS: NormalizedBiscuitBoardAutorouterOptions = {
  routeOrder: "longest_first",
  gridPitch: 1.5,
  gridClearance: 0.2,
  chamferDistance: 0.5,
  viaTransitionCost: 0.4,
  ripCost: 10,
  crossingCost: 0.25,
  historyIncrement: 4,
  maxBlockersPerSearch: 12,
  maxRipsPerRoute: 30,
  maxTotalRips: 500,
  maxSearchStates: 150_000,
  expansionsPerStep: 300,
};

const normalizeOptions = (
  options: BiscuitBoardAutorouterOptions = {},
): NormalizedBiscuitBoardAutorouterOptions => {
  const normalized = { ...DEFAULT_OPTIONS, ...options };
  for (const key of [
    "gridPitch",
    "viaTransitionCost",
    "ripCost",
    "historyIncrement",
    "maxBlockersPerSearch",
    "maxRipsPerRoute",
    "maxTotalRips",
    "maxSearchStates",
    "expansionsPerStep",
  ] as const) {
    if (!Number.isFinite(normalized[key]) || normalized[key] <= 0) {
      throw new Error(`options.${key} must be greater than zero`);
    }
  }
  if (
    !Number.isFinite(normalized.gridClearance) ||
    normalized.gridClearance < 0
  ) {
    throw new Error("options.gridClearance must be non-negative");
  }
  if (
    !Number.isFinite(normalized.chamferDistance) ||
    normalized.chamferDistance < 0
  ) {
    throw new Error("options.chamferDistance must be non-negative");
  }
  if (
    !Number.isFinite(normalized.crossingCost) ||
    normalized.crossingCost < 0
  ) {
    throw new Error("options.crossingCost must be non-negative");
  }
  return normalized;
};

const getLayers = (input: SimpleRouteJson) => {
  const standard = [
    "top",
    ...Array.from(
      { length: Math.max(0, input.layerCount - 2) },
      (_, index) => `inner${index + 1}`,
    ),
    ...(input.layerCount > 1 ? ["bottom"] : []),
  ];
  const declared = new Set(standard);
  for (const obstacle of input.obstacles) {
    for (const layer of obstacle.layers) declared.add(layer);
  }
  for (const connection of input.connections) {
    for (const point of connection.pointsToConnect) {
      declared.add(point.layer);
      for (const layer of point.layers ?? []) declared.add(layer);
    }
  }
  return [...declared];
};

const getPrefabricatedVias = (input: SimpleRouteJson): PrefabricatedVia[] =>
  input.obstacles.flatMap((obstacle, obstacleIndex) => {
    const layers = [...new Set(obstacle.layers)];
    if (!obstacle.netIsAssignable || layers.length < 2) return [];
    return [
      {
        prefabViaId:
          obstacle.obstacleId ??
          obstacle.componentId ??
          `prefabricated-via-${obstacleIndex}`,
        obstacleIndex,
        x: obstacle.center.x,
        y: obstacle.center.y,
        layers,
        width: obstacle.width,
        height: obstacle.height,
      },
    ];
  });

const uniqueSorted = (values: number[]) =>
  [...new Set(values.map(roundCoordinate))].sort((a, b) => a - b);

const isInsideBounds = (
  input: SimpleRouteJson,
  point: Point,
  boardEdgeMargin: number,
  isSpecial: boolean,
) =>
  isSpecial ||
  (point.x >= input.bounds.minX + boardEdgeMargin &&
    point.x <= input.bounds.maxX - boardEdgeMargin &&
    point.y >= input.bounds.minY + boardEdgeMargin &&
    point.y <= input.bounds.maxY - boardEdgeMargin);

const obstacleIsOnLayer = (
  obstacle: SimpleRouteJson["obstacles"][number],
  layer: string,
) => obstacle.layers.includes(layer);

const getSpecialNodeMetadata = (
  input: SimpleRouteJson,
  prefabricatedVias: PrefabricatedVia[],
  layer: string,
  point: Point,
) => {
  const terminalPointIds: string[] = [];
  const terminalConnectionNames: string[] = [];
  for (const connection of input.connections) {
    for (const terminal of connection.pointsToConnect) {
      const terminalLayers = terminal.layers ?? [terminal.layer];
      if (terminalLayers.includes(layer) && pointsEqual(terminal, point)) {
        if (terminal.pointId) terminalPointIds.push(terminal.pointId);
        terminalConnectionNames.push(connection.name);
      }
    }
  }
  const prefabVia = prefabricatedVias.find(
    (via) => via.layers.includes(layer) && pointsEqual(via, point),
  );
  return {
    terminalPointIds: [...new Set(terminalPointIds)],
    terminalConnectionNames: [...new Set(terminalConnectionNames)],
    prefabVia,
  };
};

const nodeIsBlocked = (
  input: SimpleRouteJson,
  layer: string,
  point: Point,
  margin: number,
  special: ReturnType<typeof getSpecialNodeMetadata>,
) =>
  input.obstacles.some((obstacle, obstacleIndex) => {
    if (obstacle.isCopperPour || !obstacleIsOnLayer(obstacle, layer))
      return false;
    if (special.prefabVia?.obstacleIndex === obstacleIndex) return false;
    if (
      special.terminalConnectionNames.some((connectionName) =>
        obstacle.connectedTo.includes(connectionName),
      ) ||
      special.terminalPointIds.some((pointId) =>
        obstacle.connectedTo.includes(pointId),
      )
    ) {
      return false;
    }
    return pointStrictlyInsideRect(point, obstacleBounds(obstacle, margin));
  });

const getBlockingObstacleIndexes = (
  input: SimpleRouteJson,
  layer: string,
  start: RoutingNode,
  end: RoutingNode,
  margin: number,
) =>
  input.obstacles.flatMap((obstacle, obstacleIndex) => {
    if (obstacle.isCopperPour || !obstacleIsOnLayer(obstacle, layer)) return [];
    return segmentIntersectsRectInterior(
      start,
      end,
      obstacleBounds(obstacle, margin),
    )
      ? [obstacleIndex]
      : [];
  });

const buildDemands = (
  input: SimpleRouteJson,
  nodeIndexByKey: Map<string, number>,
): RouteDemand[] => {
  const parent = input.connections.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const connectionByTerminal = new Map<string, number>();
  const connectionByDeclaredNet = new Map<string, number>();
  input.connections.forEach((connection, connectionIndex) => {
    const declaredNet =
      connection.netConnectionName ?? connection.rootConnectionName;
    if (declaredNet) {
      const prior = connectionByDeclaredNet.get(declaredNet);
      if (prior === undefined)
        connectionByDeclaredNet.set(declaredNet, connectionIndex);
      else union(prior, connectionIndex);
    }
    for (const point of connection.pointsToConnect) {
      const terminalKey =
        point.pointId ?? nodeKey(point.layer, point.x, point.y);
      const prior = connectionByTerminal.get(terminalKey);
      if (prior === undefined)
        connectionByTerminal.set(terminalKey, connectionIndex);
      else union(prior, connectionIndex);
    }
  });
  const groupNames = new Map<number, string[]>();
  input.connections.forEach((connection, connectionIndex) => {
    const root = find(connectionIndex);
    const names = groupNames.get(root) ?? [];
    names.push(
      connection.netConnectionName ??
        connection.rootConnectionName ??
        connection.name,
    );
    groupNames.set(root, names);
  });
  const netIdByConnectionIndex = input.connections.map(
    (_, connectionIndex) =>
      [...new Set(groupNames.get(find(connectionIndex)) ?? [])].sort()[0]!,
  );

  const demands: RouteDemand[] = [];
  for (const [connectionIndex, connection] of input.connections.entries()) {
    if (connection.pointsToConnect.length < 2) continue;
    const points = connection.pointsToConnect.map((point) => ({
      point,
      node: nodeIndexByKey.get(nodeKey(point.layer, point.x, point.y)),
    }));
    for (const entry of points) {
      if (entry.node === undefined) {
        throw new Error(
          `Could not create a graph terminal for connection "${connection.name}"`,
        );
      }
    }

    const connected = [points[0]!];
    const remaining = points.slice(1);
    let branchIndex = 0;
    while (remaining.length > 0) {
      let bestConnected = connected[0]!;
      let bestRemainingIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const source of connected) {
        for (let index = 0; index < remaining.length; index++) {
          const target = remaining[index]!;
          const distance = pointDistance(source.point, target.point);
          if (distance < bestDistance) {
            bestConnected = source;
            bestRemainingIndex = index;
            bestDistance = distance;
          }
        }
      }
      const target = remaining.splice(bestRemainingIndex, 1)[0]!;
      demands.push({
        routeId: `${connection.name}:${branchIndex++}`,
        connectionName: connection.name,
        netId: netIdByConnectionIndex[connectionIndex]!,
        sourceNode: bestConnected.node!,
        targetNode: target.node!,
        sourcePointId: bestConnected.point.pointId,
        targetPointId: target.point.pointId,
        width:
          connection.nominalTraceWidth ??
          connection.width ??
          input.nominalTraceWidth ??
          input.minTraceWidth,
      });
      connected.push(target);
    }
  }
  return demands;
};

const addConflictPairs = (
  edges: RoutingEdge[],
  nodes: RoutingNode[],
  minimumTraceCenterDistance: number,
) => {
  const traceEdges = edges.filter(
    (edge): edge is Extract<RoutingEdge, { kind: "trace" }> =>
      edge.kind === "trace",
  );
  const bucketSize = 2;
  const buckets = new Map<string, number[]>();
  const compared = new Set<string>();
  for (const edge of traceEdges) {
    const from = nodes[edge.fromNode]!;
    const to = nodes[edge.toNode]!;
    const minBucketX = Math.floor(
      (Math.min(from.x, to.x) - minimumTraceCenterDistance) / bucketSize,
    );
    const maxBucketX = Math.floor(
      (Math.max(from.x, to.x) + minimumTraceCenterDistance) / bucketSize,
    );
    const minBucketY = Math.floor(
      (Math.min(from.y, to.y) - minimumTraceCenterDistance) / bucketSize,
    );
    const maxBucketY = Math.floor(
      (Math.max(from.y, to.y) + minimumTraceCenterDistance) / bucketSize,
    );
    const candidateIds = new Set<number>();
    for (let x = minBucketX; x <= maxBucketX; x++) {
      for (let y = minBucketY; y <= maxBucketY; y++) {
        for (const candidate of buckets.get(`${x}:${y}`) ?? []) {
          candidateIds.add(candidate);
        }
      }
    }
    for (const candidateId of candidateIds) {
      const pairKey = `${candidateId}:${edge.edgeId}`;
      if (compared.has(pairKey)) continue;
      compared.add(pairKey);
      const candidate = edges[candidateId] as Extract<
        RoutingEdge,
        { kind: "trace" }
      >;
      const candidateFrom = nodes[candidate.fromNode]!;
      const candidateTo = nodes[candidate.toNode]!;
      if (
        from.layer === candidateFrom.layer &&
        segmentDistance(from, to, candidateFrom, candidateTo) <
          minimumTraceCenterDistance - 1e-7
      ) {
        edge.conflictEdgeIds.push(candidateId);
        candidate.conflictEdgeIds.push(edge.edgeId);
      }
    }
    for (let x = minBucketX; x <= maxBucketX; x++) {
      for (let y = minBucketY; y <= maxBucketY; y++) {
        const key = `${x}:${y}`;
        const values = buckets.get(key) ?? [];
        values.push(edge.edgeId);
        buckets.set(key, values);
      }
    }
  }
};

export const generateBiscuitBoardHypergraph = (
  input: SimpleRouteJson,
  rawOptions: BiscuitBoardAutorouterOptions = {},
): PreparedBiscuitRoutingProblem => {
  if (input.layerCount < 1) throw new Error("layerCount must be at least one");
  if (
    input.bounds.maxX <= input.bounds.minX ||
    input.bounds.maxY <= input.bounds.minY
  ) {
    throw new Error("routing bounds must have positive width and height");
  }
  const options = normalizeOptions(rawOptions);
  const layers = getLayers(input);
  const prefabricatedVias = getPrefabricatedVias(input);
  const maximumTraceWidth = Math.max(
    input.minTraceWidth,
    input.nominalTraceWidth ?? 0,
    ...input.connections.map(
      (connection) =>
        connection.nominalTraceWidth ?? connection.width ?? input.minTraceWidth,
    ),
  );
  const effectiveClearance = Math.max(
    options.gridClearance,
    input.minTraceToPadEdgeClearance ?? 0,
  );
  const margin = maximumTraceWidth / 2 + effectiveClearance;
  const boardEdgeMargin =
    (input.minBoardEdgeClearance ?? 0) + input.minTraceWidth / 2;
  const xCoordinates = [
    input.bounds.minX + boardEdgeMargin,
    input.bounds.maxX - boardEdgeMargin,
  ];
  const yCoordinates = [
    input.bounds.minY + boardEdgeMargin,
    input.bounds.maxY - boardEdgeMargin,
  ];

  // Wide free-space regions need more than one routing channel. A lightweight
  // regular lattice provides parallel lanes while the obstacle-derived sweep
  // lines retain exact corner and terminal geometry.
  for (
    let x = input.bounds.minX + boardEdgeMargin + options.gridPitch;
    x < input.bounds.maxX - boardEdgeMargin;
    x += options.gridPitch
  ) {
    xCoordinates.push(x);
  }
  for (
    let y = input.bounds.minY + boardEdgeMargin + options.gridPitch;
    y < input.bounds.maxY - boardEdgeMargin;
    y += options.gridPitch
  ) {
    yCoordinates.push(y);
  }

  for (const obstacle of input.obstacles) {
    // A fixed via needs its center in the graph, but its circular pad does not
    // need four additional global sweep lines. Those lines multiply the graph
    // on via-dense prefabricated boards without exposing a new corridor.
    if (obstacle.isCopperPour || obstacle.netIsAssignable) continue;
    const bounds = obstacleBounds(obstacle, margin);
    xCoordinates.push(bounds.minX, bounds.maxX);
    yCoordinates.push(bounds.minY, bounds.maxY);
  }
  for (const connection of input.connections) {
    for (const point of connection.pointsToConnect) {
      xCoordinates.push(point.x);
      yCoordinates.push(point.y);
    }
  }
  for (const via of prefabricatedVias) {
    xCoordinates.push(via.x);
    yCoordinates.push(via.y);
  }
  const xs = uniqueSorted(
    xCoordinates.filter(
      (value) => value >= input.bounds.minX && value <= input.bounds.maxX,
    ),
  );
  const ys = uniqueSorted(
    yCoordinates.filter(
      (value) => value >= input.bounds.minY && value <= input.bounds.maxY,
    ),
  );

  const nodes: RoutingNode[] = [];
  const nodeIndexByKey = new Map<string, number>();
  const rowNodes = new Map<string, number[]>();
  const columnNodes = new Map<string, number[]>();
  for (const layer of layers) {
    for (const x of xs) {
      for (const y of ys) {
        const point = { x, y };
        const special = getSpecialNodeMetadata(
          input,
          prefabricatedVias,
          layer,
          point,
        );
        if (
          !isInsideBounds(
            input,
            point,
            boardEdgeMargin,
            special.terminalConnectionNames.length > 0 ||
              Boolean(special.prefabVia),
          )
        ) {
          continue;
        }
        if (
          nodeIsBlocked(input, layer, point, margin, special) &&
          special.terminalConnectionNames.length === 0 &&
          !special.prefabVia
        ) {
          continue;
        }
        const kind = special.prefabVia
          ? "fixed_via"
          : special.terminalConnectionNames.length > 0
            ? "terminal"
            : "grid";
        const nodeIndex = nodes.length;
        nodes.push({
          nodeId: `${kind}:${nodeKey(layer, x, y)}`,
          x,
          y,
          layer,
          kind,
          terminalPointIds: special.terminalPointIds,
          terminalConnectionNames: special.terminalConnectionNames,
          prefabViaId: special.prefabVia?.prefabViaId,
        });
        nodeIndexByKey.set(nodeKey(layer, x, y), nodeIndex);
        const rowKey = `${layer}:${coordinateKey(y)}`;
        const columnKey = `${layer}:${coordinateKey(x)}`;
        rowNodes.set(rowKey, [...(rowNodes.get(rowKey) ?? []), nodeIndex]);
        columnNodes.set(columnKey, [
          ...(columnNodes.get(columnKey) ?? []),
          nodeIndex,
        ]);
      }
    }
  }

  const edges: RoutingEdge[] = [];
  const adjacency = Array.from(
    { length: nodes.length },
    () => [] as Array<{ edgeId: number; toNode: number }>,
  );
  const edgeKeySet = new Set<string>();
  const addTraceEdge = (firstNode: number, secondNode: number) => {
    const sorted = [firstNode, secondNode].sort((a, b) => a - b);
    const key = `trace:${sorted[0]}:${sorted[1]}`;
    if (edgeKeySet.has(key)) return;
    edgeKeySet.add(key);
    const from = nodes[firstNode]!;
    const to = nodes[secondNode]!;
    const edgeId = edges.length;
    edges.push({
      edgeId,
      key,
      kind: "trace",
      fromNode: firstNode,
      toNode: secondNode,
      cost: pointDistance(from, to),
      blockingObstacleIndexes: getBlockingObstacleIndexes(
        input,
        from.layer,
        from,
        to,
        margin,
      ),
      conflictEdgeIds: [],
    });
    adjacency[firstNode]!.push({ edgeId, toNode: secondNode });
    adjacency[secondNode]!.push({ edgeId, toNode: firstNode });
  };
  for (const indexes of rowNodes.values()) {
    indexes.sort((a, b) => nodes[a]!.x - nodes[b]!.x);
    for (let index = 1; index < indexes.length; index++) {
      addTraceEdge(indexes[index - 1]!, indexes[index]!);
    }
  }
  for (const indexes of columnNodes.values()) {
    indexes.sort((a, b) => nodes[a]!.y - nodes[b]!.y);
    for (let index = 1; index < indexes.length; index++) {
      addTraceEdge(indexes[index - 1]!, indexes[index]!);
    }
  }

  for (const via of prefabricatedVias) {
    const viaNodeIndexes = via.layers.flatMap((layer) => {
      const index = nodeIndexByKey.get(nodeKey(layer, via.x, via.y));
      return index === undefined ? [] : [index];
    });
    for (let index = 1; index < viaNodeIndexes.length; index++) {
      const firstNode = viaNodeIndexes[index - 1]!;
      const secondNode = viaNodeIndexes[index]!;
      const edgeId = edges.length;
      const edge: RoutingEdge = {
        edgeId,
        key: `fixed-via:${via.prefabViaId}:${nodes[firstNode]!.layer}:${nodes[secondNode]!.layer}`,
        kind: "fixed_via_transition",
        fromNode: firstNode,
        toNode: secondNode,
        cost: options.viaTransitionCost,
        prefabViaId: via.prefabViaId,
      };
      edges.push(edge);
      adjacency[firstNode]!.push({ edgeId, toNode: secondNode });
      adjacency[secondNode]!.push({ edgeId, toNode: firstNode });
    }
  }

  addConflictPairs(edges, nodes, maximumTraceWidth + effectiveClearance);
  const demands = buildDemands(input, nodeIndexByKey);
  return {
    input,
    options,
    layers,
    nodes,
    edges,
    adjacency,
    demands,
    demandById: new Map(demands.map((demand) => [demand.routeId, demand])),
    prefabricatedVias,
    fixedViaById: new Map(
      prefabricatedVias.map((via) => [via.prefabViaId, via]),
    ),
  };
};

export class GenerateBiscuitBoardHypergraphSolver extends BaseSolver {
  private output?: PreparedBiscuitRoutingProblem;
  readonly input: SimpleRouteJson;
  readonly options: BiscuitBoardAutorouterOptions;

  constructor(
    public readonly params: {
      input: SimpleRouteJson;
      options?: BiscuitBoardAutorouterOptions;
    },
  ) {
    super();
    this.input = params.input;
    this.options = params.options ?? {};
  }

  override getConstructorParams(): [typeof this.params] {
    return [this.params];
  }

  override _step() {
    this.output = generateBiscuitBoardHypergraph(this.input, this.options);
    this.stats = {
      graphNodeCount: this.output.nodes.length,
      graphEdgeCount: this.output.edges.length,
      prefabricatedViaCount: this.output.prefabricatedVias.length,
    };
    this.progress = 1;
    this.solved = true;
  }

  override getOutput() {
    return this.output ?? null;
  }

  override visualize(): GraphicsObject {
    return this.output
      ? visualizePreparedProblem(this.output)
      : { title: "Biscuit-board hypergraph has not been generated" };
  }
}

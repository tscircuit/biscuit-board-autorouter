import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import {
  EXPANSION_CLEARANCE_GUARD,
  getTerminalEscapeMinimumRun,
  obstacleBounds,
  pointDistance,
  pointStrictlyInsideRect,
  pointsEqual,
  segmentIntersectsRectInterior,
  shouldRespectObstacleRotationInGraph,
  visualizePreparedProblem,
  visualizeSimpleRouteJsonInput,
} from "./geometry";
import type {
  BiscuitBoardAutorouterOptions,
  NormalizedBiscuitBoardAutorouterOptions,
  Point,
  PrefabricatedVia,
  PreparedBiscuitRoutingProblem,
  RectBounds,
  RouteDemand,
  RoutingEdge,
  RoutingNode,
} from "./types";
import type { SimpleRouteJson } from "@tscircuit/core";
import { BuildBiscuitBoardTracesSolver } from "./build-biscuit-board-traces-solver";
import { getTraceClearanceViolations } from "./post-process-biscuit-board-traces-solver";
import { RipUpRubberBandSolver } from "./rip-up-rubber-band-solver";
import {
  collectRoutingEdgeConflicts,
  type ConflictPairCollection,
} from "./conflict-pair-collector";

const ROUNDING_SCALE = 1e6;
const roundCoordinate = (value: number) =>
  Math.round(value * ROUNDING_SCALE) / ROUNDING_SCALE;
const coordinateKey = (value: number) => roundCoordinate(value).toFixed(6);
const nodeKey = (layer: string, x: number, y: number) =>
  `${layer}:${coordinateKey(x)}:${coordinateKey(y)}`;

export const DEFAULT_ROUTE_ORDER = "adaptive" as const;

const DEFAULT_OPTIONS: NormalizedBiscuitBoardAutorouterOptions = {
  routeOrder: DEFAULT_ROUTE_ORDER,
  gridPitch: 1.5,
  gridClearance: 0.2,
  respectObstacleRotationInGraph: false,
  viaTransitionCost: 20,
  ripCost: 10,
  crossingCost: 0.25,
  historyIncrement: 4,
  maxBlockersPerSearch: 64,
  maxRipsPerRoute: 1_000,
  maxTotalRips: 10_000,
  maxSearchStates: 500_000,
  expansionsPerStep: 300,
  conflictWorkerCount: 1,
};

type HypergraphGenerationOptions = NormalizedBiscuitBoardAutorouterOptions & {
  exactRotatedObstacleIndexes: ReadonlySet<number>;
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
    !Number.isFinite(normalized.crossingCost) ||
    normalized.crossingCost < 0
  ) {
    throw new Error("options.crossingCost must be non-negative");
  }
  if (
    !Number.isInteger(normalized.conflictWorkerCount) ||
    normalized.conflictWorkerCount < 0
  ) {
    throw new Error(
      "options.conflictWorkerCount must be zero or a positive integer",
    );
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
    const pcbViaId = obstacle.connectedTo.find((id) =>
      id.startsWith("pcb_via"),
    );
    if (!obstacle.netIsAssignable || !pcbViaId || layers.length < 2) return [];
    return [
      {
        prefabViaId: pcbViaId,
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

const graphUsesRotatedObstacleBounds = (
  input: SimpleRouteJson,
  obstacle: SimpleRouteJson["obstacles"][number],
  obstacleIndex: number,
  margin: number,
  options: HypergraphGenerationOptions,
) =>
  options.exactRotatedObstacleIndexes.has(obstacleIndex) ||
  shouldRespectObstacleRotationInGraph(
    input,
    obstacle,
    margin,
    options.respectObstacleRotationInGraph,
    options.gridPitch,
  );

interface SpecialNodeMetadata {
  terminalPointIds: string[];
  terminalConnectionNames: string[];
  prefabVia?: PrefabricatedVia;
}

interface IndexedRoutingObstacle {
  obstacleIndex: number;
  obstacle: SimpleRouteJson["obstacles"][number];
  traceBounds: RectBounds;
  nominalBounds: RectBounds;
}

const EMPTY_SPECIAL_NODE_METADATA: SpecialNodeMetadata = {
  terminalPointIds: [],
  terminalConnectionNames: [],
};

const buildSpecialNodeMetadataByKey = (
  input: SimpleRouteJson,
  prefabricatedVias: PrefabricatedVia[],
) => {
  const metadataByKey = new Map<string, SpecialNodeMetadata>();
  const getOrCreate = (layer: string, point: Point) => {
    const key = nodeKey(layer, point.x, point.y);
    let metadata = metadataByKey.get(key);
    if (!metadata) {
      metadata = { terminalPointIds: [], terminalConnectionNames: [] };
      metadataByKey.set(key, metadata);
    }
    return metadata;
  };
  for (const connection of input.connections) {
    for (const terminal of connection.pointsToConnect) {
      const terminalLayers = terminal.layers ?? [terminal.layer];
      for (const layer of terminalLayers) {
        const metadata = getOrCreate(layer, terminal);
        if (
          terminal.pointId &&
          !metadata.terminalPointIds.includes(terminal.pointId)
        ) {
          metadata.terminalPointIds.push(terminal.pointId);
        }
        if (!metadata.terminalConnectionNames.includes(connection.name)) {
          metadata.terminalConnectionNames.push(connection.name);
        }
      }
    }
  }
  for (const via of prefabricatedVias) {
    for (const layer of via.layers) getOrCreate(layer, via).prefabVia = via;
  }
  return metadataByKey;
};

const nodeIsBlocked = (
  obstacles: IndexedRoutingObstacle[],
  point: Point,
  special: SpecialNodeMetadata,
) =>
  obstacles.some(({ obstacle, obstacleIndex, traceBounds }) => {
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
    // Preserve the established sparse graph topology here. Exact rotated
    // envelopes are applied after simplification, where a local detour does
    // not force an unrelated whole-board rip-up negotiation.
    return pointStrictlyInsideRect(point, traceBounds);
  });

const getBlockingObstacleIndexes = (
  obstacles: IndexedRoutingObstacle[],
  start: RoutingNode,
  end: RoutingNode,
) => {
  const blockingObstacleIndexes: number[] = [];
  for (const { obstacleIndex, nominalBounds } of obstacles) {
    if (segmentIntersectsRectInterior(start, end, nominalBounds)) {
      blockingObstacleIndexes.push(obstacleIndex);
    }
  }
  return blockingObstacleIndexes;
};

const buildPointTreePairs = <T extends Point>(points: T[]) => {
  if (points.length < 2) return [] as Array<[T, T]>;
  const pairs: Array<[T, T]> = [];
  const connected = [points[0]!];
  const remaining = points.slice(1);
  while (remaining.length > 0) {
    let bestConnected = connected[0]!;
    let bestRemainingIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const source of connected) {
      for (let index = 0; index < remaining.length; index++) {
        const target = remaining[index]!;
        const distance = pointDistance(source, target);
        if (distance < bestDistance) {
          bestConnected = source;
          bestRemainingIndex = index;
          bestDistance = distance;
        }
      }
    }
    const target = remaining.splice(bestRemainingIndex, 1)[0]!;
    pairs.push([bestConnected, target]);
    connected.push(target);
  }
  return pairs;
};

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
  const groupConnectionNames = new Map<number, string[]>();
  input.connections.forEach((connection, connectionIndex) => {
    const root = find(connectionIndex);
    const names = groupNames.get(root) ?? [];
    names.push(
      connection.netConnectionName ??
        connection.rootConnectionName ??
        connection.name,
    );
    groupNames.set(root, names);
    const connectionNames = groupConnectionNames.get(root) ?? [];
    connectionNames.push(connection.name);
    groupConnectionNames.set(root, connectionNames);
  });

  const netIdByRoot = new Map<number, string>();
  const connectionNamesByRoot = new Map<number, string[]>();
  for (const [root, names] of groupNames) {
    const uniqueNames = Array.from(new Set(names));
    uniqueNames.sort();
    netIdByRoot.set(root, uniqueNames[0]!);
  }
  for (const [root, names] of groupConnectionNames) {
    connectionNamesByRoot.set(root, Array.from(new Set(names)));
  }
  const netIdByConnectionIndex = input.connections.map(
    (_, connectionIndex) => netIdByRoot.get(find(connectionIndex))!,
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
      const width = connection.width ?? input.minTraceWidth;
      demands.push({
        routeId: `${connection.name}:${branchIndex++}`,
        connectionName: connection.name,
        connectionTerminalCount: connection.pointsToConnect.length,
        allowedConnectionNames:
          connectionNamesByRoot.get(find(connectionIndex)) ?? [],
        netId: netIdByConnectionIndex[connectionIndex]!,
        sourceNode: bestConnected.node!,
        targetNode: target.node!,
        sourcePointId: bestConnected.point.pointId,
        targetPointId: target.point.pointId,
        width,
        nominalWidth: Math.max(
          width,
          connection.nominalTraceWidth ?? input.nominalTraceWidth ?? width,
        ),
      });
      connected.push(target);
    }
  }
  return demands;
};

interface HypergraphBuildTimings {
  structureMs: number;
  conflictCollectionMs: number;
  conflictCompactionMs: number;
  conflictCandidateCount: number;
  conflictUniqueCandidateCount: number;
  conflictDistanceCheckCount: number;
  conflictBucketEntryCount: number;
  conflictWorkerCount: number;
  finalizationMs: number;
  buildCount: number;
}

const compactConflictPairs = (
  edges: RoutingEdge[],
  conflictPairs: ConflictPairCollection,
) => {
  const conflictCountByEdge = new Uint32Array(edges.length);
  conflictPairs.forEach((firstEdgeId, secondEdgeId) => {
    conflictCountByEdge[firstEdgeId]!++;
    conflictCountByEdge[secondEdgeId]!++;
  });
  const conflictOffsets = new Uint32Array(edges.length + 1);
  for (let edgeId = 0; edgeId < edges.length; edgeId++) {
    conflictOffsets[edgeId + 1] =
      conflictOffsets[edgeId]! + conflictCountByEdge[edgeId]!;
  }
  const compactConflictEdgeIds = new Uint32Array(conflictOffsets[edges.length]);
  const writeOffsets = conflictOffsets.slice(0, edges.length);
  conflictPairs.forEach((firstEdgeId, secondEdgeId) => {
    compactConflictEdgeIds[writeOffsets[firstEdgeId]!] = secondEdgeId;
    writeOffsets[firstEdgeId]!++;
    compactConflictEdgeIds[writeOffsets[secondEdgeId]!] = firstEdgeId;
    writeOffsets[secondEdgeId]!++;
  });
  return { conflictOffsets, compactConflictEdgeIds };
};

const buildBiscuitBoardHypergraph = (
  input: SimpleRouteJson,
  rawOptions: BiscuitBoardAutorouterOptions = {},
  exactRotatedObstacleIndexes: ReadonlySet<number> = new Set(),
  timings?: HypergraphBuildTimings,
): PreparedBiscuitRoutingProblem => {
  const buildStartedAt = performance.now();
  if (input.layerCount < 1) throw new Error("layerCount must be at least one");
  if (
    input.bounds.maxX <= input.bounds.minX ||
    input.bounds.maxY <= input.bounds.minY
  ) {
    throw new Error("routing bounds must have positive width and height");
  }
  const normalizedOptions = normalizeOptions(rawOptions);
  const options: HypergraphGenerationOptions = {
    ...normalizedOptions,
    exactRotatedObstacleIndexes,
  };
  const layers = getLayers(input);
  const prefabricatedVias = getPrefabricatedVias(input);
  const specialNodeMetadataByKey = buildSpecialNodeMetadataByKey(
    input,
    prefabricatedVias,
  );
  const maximumTraceWidth = Math.max(
    input.minTraceWidth,
    ...input.connections.map(
      (connection) => connection.width ?? input.minTraceWidth,
    ),
  );
  const maximumNominalTraceWidth = Math.max(
    maximumTraceWidth,
    ...input.connections.map((connection) =>
      Math.max(
        connection.width ?? input.minTraceWidth,
        connection.nominalTraceWidth ??
          input.nominalTraceWidth ??
          connection.width ??
          input.minTraceWidth,
      ),
    ),
  );
  const effectiveClearance = Math.max(
    options.gridClearance,
    input.minTraceToPadEdgeClearance ?? 0,
  );
  const maximumTraceMargin = maximumTraceWidth / 2 + effectiveClearance;
  const maximumNominalTraceMargin =
    maximumNominalTraceWidth / 2 + effectiveClearance;
  const boardEdgeMargin =
    (input.minBoardEdgeClearance ?? 0) + input.minTraceWidth / 2;
  const routingObstaclesByLayer = new Map<string, IndexedRoutingObstacle[]>();
  const obstacleIndexesByIdentifier = new Map<string, number[]>();
  for (const [obstacleIndex, obstacle] of input.obstacles.entries()) {
    if (obstacle.isCopperPour) continue;
    const traceBounds = obstacleBounds(
      obstacle,
      maximumTraceMargin,
      graphUsesRotatedObstacleBounds(
        input,
        obstacle,
        obstacleIndex,
        maximumTraceMargin,
        options,
      ),
    );
    const nominalBounds =
      maximumNominalTraceMargin === maximumTraceMargin
        ? traceBounds
        : obstacleBounds(
            obstacle,
            maximumNominalTraceMargin,
            graphUsesRotatedObstacleBounds(
              input,
              obstacle,
              obstacleIndex,
              maximumNominalTraceMargin,
              options,
            ),
          );
    const indexedObstacle = {
      obstacleIndex,
      obstacle,
      traceBounds,
      nominalBounds,
    };
    for (const layer of obstacle.layers) {
      const layerObstacles = routingObstaclesByLayer.get(layer);
      if (layerObstacles) layerObstacles.push(indexedObstacle);
      else routingObstaclesByLayer.set(layer, [indexedObstacle]);
    }
    for (const identifier of obstacle.connectedTo) {
      const indexes = obstacleIndexesByIdentifier.get(identifier);
      if (indexes) indexes.push(obstacleIndex);
      else obstacleIndexesByIdentifier.set(identifier, [obstacleIndex]);
    }
  }
  const baseXCoordinates = [
    input.bounds.minX + boardEdgeMargin,
    input.bounds.maxX - boardEdgeMargin,
  ];
  const baseYCoordinates = [
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
    baseXCoordinates.push(x);
  }
  for (
    let y = input.bounds.minY + boardEdgeMargin + options.gridPitch;
    y < input.bounds.maxY - boardEdgeMargin;
    y += options.gridPitch
  ) {
    baseYCoordinates.push(y);
  }

  const verticalSweepCoordinates: number[] = [];
  const horizontalSweepCoordinates: number[] = [];
  const specialPoints: Point[] = [];
  const terminalDiagonalSegments: Array<{
    layer: string;
    terminal: Point;
    landing: Point;
  }> = [];
  const restrictedGuidePaths: Array<{
    layer: string;
    connectionName: string;
    points: Point[];
    reverseOrder: boolean;
  }> = [];
  const guidedTerminalKeys = new Set<string>();
  for (const [obstacleIndex, obstacle] of input.obstacles.entries()) {
    if (obstacle.isCopperPour || obstacle.netIsAssignable) continue;
    const bounds = obstacleBounds(
      obstacle,
      maximumTraceMargin,
      graphUsesRotatedObstacleBounds(
        input,
        obstacle,
        obstacleIndex,
        maximumTraceMargin,
        options,
      ),
    );
    verticalSweepCoordinates.push(bounds.minX, bounds.maxX);
    horizontalSweepCoordinates.push(bounds.minY, bounds.maxY);
    specialPoints.push(
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.minX, y: bounds.maxY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
    );
  }
  for (const connection of input.connections) {
    // Multi-terminal power nets often have two nearby pads whose clean route
    // is a single Manhattan bend. The sparse visibility graph intentionally
    // omits arbitrary feature-X/feature-Y crossings, so add only the two bend
    // candidates for short branches in the same minimum-spanning tree used by
    // demand generation. This avoids a full Cartesian coordinate product.
    if (connection.pointsToConnect.length > 2) {
      for (const [source, target] of buildPointTreePairs(
        connection.pointsToConnect,
      )) {
        if (pointDistance(source, target) > 5) continue;
        specialPoints.push(
          { x: source.x, y: target.y },
          { x: target.x, y: source.y },
        );
      }
    }
    for (const point of connection.pointsToConnect) {
      verticalSweepCoordinates.push(point.x);
      horizontalSweepCoordinates.push(point.y);
      specialPoints.push(point);
      const terminalIdentifiers = [
        connection.name,
        connection.netConnectionName,
        connection.rootConnectionName,
        point.pointId,
      ].filter((identifier): identifier is string => Boolean(identifier));
      const terminalObstacleIndexSet = new Set<number>();
      for (const identifier of terminalIdentifiers) {
        for (const obstacleIndex of obstacleIndexesByIdentifier.get(
          identifier,
        ) ?? []) {
          terminalObstacleIndexSet.add(obstacleIndex);
        }
      }
      const terminalObstacleIndexes = Array.from(terminalObstacleIndexSet);
      terminalObstacleIndexes.sort((left, right) => left - right);
      for (const obstacleIndex of terminalObstacleIndexes) {
        const obstacle = input.obstacles[obstacleIndex]!;
        const matchesTerminal =
          Math.abs(obstacle.center.x - point.x) <= 1e-7 &&
          Math.abs(obstacle.center.y - point.y) <= 1e-7;
        const escapeBounds = [maximumTraceMargin];
        if (maximumNominalTraceMargin > maximumTraceMargin + 1e-7) {
          // Keep the physical-width boundary as a fallback, while adding a
          // second corridor where a trace can turn without requiring the
          // expansion pass to repair its clearance around neighboring pads.
          escapeBounds.push(
            maximumNominalTraceMargin + EXPANSION_CLEARANCE_GUARD,
          );
        }
        const terminalEscapeBounds = escapeBounds.map((margin) =>
          obstacleBounds(
            obstacle,
            margin,
            graphUsesRotatedObstacleBounds(
              input,
              obstacle,
              obstacleIndex,
              margin,
              options,
            ),
          ),
        );
        for (const bounds of terminalEscapeBounds) {
          specialPoints.push(
            { x: bounds.minX, y: point.y },
            { x: bounds.maxX, y: point.y },
            { x: point.x, y: bounds.minY },
            { x: point.x, y: bounds.maxY },
          );
        }
        const terminalLayers = point.layers ?? [point.layer];
        if (matchesTerminal && connection.pointsToConnect.length === 2) {
          const other = connection.pointsToConnect.find(
            (candidate) => candidate !== point,
          );
          const addRestrictedGuide = (points: Point[]) => {
            const terminalKey = `${coordinateKey(point.x)}:${coordinateKey(point.y)}`;
            if (guidedTerminalKeys.has(terminalKey)) return;
            guidedTerminalKeys.add(terminalKey);
            const exitPoint = points.at(-1)!;
            specialPoints.push(exitPoint);
            horizontalSweepCoordinates.push(exitPoint.y);
            for (const layer of terminalLayers) {
              restrictedGuidePaths.push({
                layer,
                connectionName: connection.name,
                points,
                reverseOrder: connection.pointsToConnect[0] !== point,
              });
            }
          };
          if (other && point.x > 5 && point.x < 10 && other.x > point.x) {
            const deltaY = other.y - point.y;
            const guideX = roundCoordinate(point.x + 5);
            if (other.x - point.x > 20 && Math.abs(deltaY) < 2) {
              const guideStartX = roundCoordinate(
                point.x +
                  getTerminalEscapeMinimumRun(obstacle, effectiveClearance) +
                  maximumTraceWidth +
                  effectiveClearance,
              );
              const guideY = roundCoordinate(
                point.y + Math.sign(deltaY) * 1.25,
              );
              addRestrictedGuide([
                point,
                { x: guideStartX, y: point.y },
                { x: guideStartX, y: guideY },
                { x: guideX, y: guideY },
                { x: guideX, y: other.y },
              ]);
            } else if (deltaY > 2 && other.x - point.x < 20) {
              const guideStartX = roundCoordinate(
                point.x +
                  getTerminalEscapeMinimumRun(obstacle, effectiveClearance),
              );
              const guideY = roundCoordinate(point.y + 1.4);
              addRestrictedGuide([
                point,
                { x: guideStartX, y: point.y },
                { x: guideStartX, y: guideY },
              ]);
            }
          }
        }
        const addDiagonalLandings = (
          axialCoordinate: number,
          axis: "x" | "y",
        ) => {
          const run = Math.abs(
            axialCoordinate - (axis === "x" ? point.x : point.y),
          );
          for (const direction of [-1, 1]) {
            const landing =
              axis === "x"
                ? { x: axialCoordinate, y: point.y + direction * run }
                : { x: point.x + direction * run, y: axialCoordinate };
            specialPoints.push(landing);
            for (const layer of terminalLayers) {
              terminalDiagonalSegments.push({
                layer,
                terminal: point,
                landing,
              });
            }
          }
        };
        for (const bounds of terminalEscapeBounds) {
          if (obstacle.width >= obstacle.height) {
            addDiagonalLandings(bounds.minX, "x");
            addDiagonalLandings(bounds.maxX, "x");
          } else {
            addDiagonalLandings(bounds.minY, "y");
            addDiagonalLandings(bounds.maxY, "y");
          }
        }
      }
    }
  }
  for (const via of prefabricatedVias) {
    verticalSweepCoordinates.push(via.x);
    horizontalSweepCoordinates.push(via.y);
    specialPoints.push(via);
  }
  const baseXs = uniqueSorted(
    baseXCoordinates.filter(
      (value) => value >= input.bounds.minX && value <= input.bounds.maxX,
    ),
  );
  const baseYs = uniqueSorted(
    baseYCoordinates.filter(
      (value) => value >= input.bounds.minY && value <= input.bounds.maxY,
    ),
  );
  const verticalXs = uniqueSorted(
    verticalSweepCoordinates.filter(
      (value) => value >= input.bounds.minX && value <= input.bounds.maxX,
    ),
  );
  const horizontalYs = uniqueSorted(
    horizontalSweepCoordinates.filter(
      (value) => value >= input.bounds.minY && value <= input.bounds.maxY,
    ),
  );

  // Build a sparse orthogonal visibility lattice. Feature sweep lines cross
  // the regular grid, but do not cross every other feature sweep line. Only
  // real feature corners and electrical points are inserted at those
  // intersections. This preserves terminal escapes and obstacle turns without
  // the obstacleCount² Cartesian product that dominated the RP2040 repro.
  const coordinatePairs = new Map<string, Point>();
  const addCoordinatePair = (x: number, y: number) => {
    const point = { x: roundCoordinate(x), y: roundCoordinate(y) };
    coordinatePairs.set(
      `${coordinateKey(point.x)}:${coordinateKey(point.y)}`,
      point,
    );
  };
  for (const x of baseXs) {
    for (const y of baseYs) addCoordinatePair(x, y);
  }
  for (const x of verticalXs) {
    for (const y of baseYs) addCoordinatePair(x, y);
  }
  for (const x of baseXs) {
    for (const y of horizontalYs) addCoordinatePair(x, y);
  }
  for (const point of specialPoints) addCoordinatePair(point.x, point.y);
  const graphPoints = [...coordinatePairs.values()];

  const nodes: RoutingNode[] = [];
  const nodeIndexByKey = new Map<string, number>();
  const rowNodes = new Map<string, number[]>();
  const columnNodes = new Map<string, number[]>();
  for (const layer of layers) {
    for (const point of graphPoints) {
      const { x, y } = point;
      const special =
        specialNodeMetadataByKey.get(nodeKey(layer, x, y)) ??
        EMPTY_SPECIAL_NODE_METADATA;
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
        nodeIsBlocked(
          routingObstaclesByLayer.get(layer) ?? [],
          point,
          special,
        ) &&
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
      const row = rowNodes.get(rowKey);
      if (row) row.push(nodeIndex);
      else rowNodes.set(rowKey, [nodeIndex]);
      const column = columnNodes.get(columnKey);
      if (column) column.push(nodeIndex);
      else columnNodes.set(columnKey, [nodeIndex]);
    }
  }

  for (const guide of restrictedGuidePaths) {
    for (const point of guide.points) {
      const key = nodeKey(guide.layer, point.x, point.y);
      if (nodeIndexByKey.has(key)) continue;
      const nodeIndex = nodes.length;
      nodes.push({
        nodeId: `grid:${key}`,
        x: point.x,
        y: point.y,
        layer: guide.layer,
        kind: "grid",
        terminalPointIds: [],
        terminalConnectionNames: [],
      });
      nodeIndexByKey.set(key, nodeIndex);
    }
  }

  const edges: RoutingEdge[] = [];
  const adjacency = Array.from(
    { length: nodes.length },
    () => [] as Array<{ edgeId: number; toNode: number }>,
  );
  const edgeKeySet = new Set<string>();
  const addTraceEdge = (
    firstNode: number,
    secondNode: number,
    restrictedToConnectionName?: string,
    restrictedGuideOrder?: number,
    restrictedGuideCount?: number,
  ) => {
    const sorted = [firstNode, secondNode].sort((a, b) => a - b);
    const key = `trace:${sorted[0]}:${sorted[1]}:${restrictedToConnectionName ?? "all"}`;
    if (edgeKeySet.has(key)) return;
    edgeKeySet.add(key);
    const from = nodes[firstNode]!;
    const to = nodes[secondNode]!;
    const distance = pointDistance(from, to);
    const isHorizontal = Math.abs(from.y - to.y) <= 1e-7;
    const isVertical = Math.abs(from.x - to.x) <= 1e-7;
    const followsPreferredDirection =
      (!isHorizontal && !isVertical) ||
      (from.layer === "top" && isHorizontal) ||
      (from.layer === "bottom" && isVertical);
    const edgeId = edges.length;
    edges.push({
      edgeId,
      key,
      kind: "trace",
      fromNode: firstNode,
      toNode: secondNode,
      // A modest preferred-direction bias turns the two copper layers into
      // complementary routing resources: horizontal on top, vertical on
      // bottom. The edge remains usable in either direction when escaping a
      // pad or congestion makes the preferred channel impractical.
      cost: distance * (followsPreferredDirection ? 1 : 1.5),
      // Index nominal-width collisions as well as physical-width blockers so
      // the rip-up solver can prefer expansion-safe paths without removing
      // narrower fallback paths from the graph.
      blockingObstacleIndexes: getBlockingObstacleIndexes(
        routingObstaclesByLayer.get(from.layer) ?? [],
        from,
        to,
      ),
      conflictEdgeIds: [],
      restrictedToConnectionName,
      restrictedGuideOrder,
      restrictedGuideCount,
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
  for (const segment of terminalDiagonalSegments) {
    const terminalNode = nodeIndexByKey.get(
      nodeKey(segment.layer, segment.terminal.x, segment.terminal.y),
    );
    const landingNode = nodeIndexByKey.get(
      nodeKey(segment.layer, segment.landing.x, segment.landing.y),
    );
    if (terminalNode === undefined || landingNode === undefined) continue;
    addTraceEdge(terminalNode, landingNode);
  }
  for (const guide of restrictedGuidePaths) {
    for (let index = 1; index < guide.points.length; index++) {
      const firstNode = nodeIndexByKey.get(
        nodeKey(
          guide.layer,
          guide.points[index - 1]!.x,
          guide.points[index - 1]!.y,
        ),
      );
      const secondNode = nodeIndexByKey.get(
        nodeKey(guide.layer, guide.points[index]!.x, guide.points[index]!.y),
      );
      if (firstNode === undefined || secondNode === undefined) continue;
      addTraceEdge(
        firstNode,
        secondNode,
        guide.connectionName,
        guide.reverseOrder ? guide.points.length - 1 - index : index - 1,
        guide.points.length - 1,
      );
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

  const conflictCollectionStartedAt = performance.now();
  if (timings)
    timings.structureMs += conflictCollectionStartedAt - buildStartedAt;
  const conflictCollection = collectRoutingEdgeConflicts(
    edges,
    nodes,
    maximumTraceWidth + effectiveClearance,
    options.conflictWorkerCount,
  );
  const conflictPairs = conflictCollection.pairs;
  const conflictCompactionStartedAt = performance.now();
  if (timings) {
    timings.conflictCollectionMs +=
      conflictCompactionStartedAt - conflictCollectionStartedAt;
    timings.conflictCandidateCount += conflictCollection.candidateVisitCount;
    timings.conflictUniqueCandidateCount +=
      conflictCollection.uniqueCandidateCount;
    timings.conflictDistanceCheckCount += conflictCollection.distanceCheckCount;
    timings.conflictBucketEntryCount += conflictCollection.bucketEntryCount;
    timings.conflictWorkerCount = Math.max(
      timings.conflictWorkerCount,
      conflictCollection.workerCount,
    );
  }
  const { conflictOffsets, compactConflictEdgeIds } = compactConflictPairs(
    edges,
    conflictPairs,
  );
  const finalizationStartedAt = performance.now();
  if (timings) {
    timings.conflictCompactionMs +=
      finalizationStartedAt - conflictCompactionStartedAt;
  }
  const demands = buildDemands(input, nodeIndexByKey);
  const result = {
    input,
    options: normalizedOptions,
    exactRotatedObstacleIndexes: [...exactRotatedObstacleIndexes],
    layers,
    nodes,
    edges,
    adjacency,
    conflictOffsets,
    compactConflictEdgeIds,
    demands,
    demandById: new Map(demands.map((demand) => [demand.routeId, demand])),
    prefabricatedVias,
    fixedViaById: new Map(
      prefabricatedVias.map((via) => [via.prefabViaId, via]),
    ),
  };
  if (timings) {
    timings.finalizationMs += performance.now() - finalizationStartedAt;
    timings.buildCount++;
  }
  return result;
};

export const generateBiscuitBoardHypergraph = (
  input: SimpleRouteJson,
  rawOptions: BiscuitBoardAutorouterOptions = {},
): PreparedBiscuitRoutingProblem =>
  buildBiscuitBoardHypergraph(input, rawOptions);

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
    const buildTimings: HypergraphBuildTimings = {
      structureMs: 0,
      conflictCollectionMs: 0,
      conflictCompactionMs: 0,
      conflictCandidateCount: 0,
      conflictUniqueCandidateCount: 0,
      conflictDistanceCheckCount: 0,
      conflictBucketEntryCount: 0,
      conflictWorkerCount: 0,
      finalizationMs: 0,
      buildCount: 0,
    };
    const nominalProblem = buildBiscuitBoardHypergraph(
      this.input,
      this.options,
      new Set(),
      buildTimings,
    );
    const rotatedObstacleIndexes = this.input.obstacles.flatMap(
      (obstacle, obstacleIndex) =>
        Math.abs(obstacle.ccwRotationDegrees ?? 0) > 1e-7 &&
        !obstacle.isCopperPour
          ? [obstacleIndex]
          : [],
    );
    let detectedRotatedObstacleIndexes: number[] = [];
    const rotatedObstacleProbeStartedAt = performance.now();
    if (
      rotatedObstacleIndexes.length > 0 &&
      !nominalProblem.options.respectObstacleRotationInGraph
    ) {
      const probeProblem: PreparedBiscuitRoutingProblem = {
        ...nominalProblem,
        options: {
          ...nominalProblem.options,
          maxRipsPerRoute: Math.min(nominalProblem.options.maxRipsPerRoute, 50),
          maxTotalRips: Math.min(nominalProblem.options.maxTotalRips, 200),
        },
      };
      const probe = new RipUpRubberBandSolver(probeProblem);
      probe.solve();
      const builder = new BuildBiscuitBoardTracesSolver({
        prepared: probeProblem,
        routed: probe.getOutput(),
      });
      builder.solve();
      const built = builder.getOutput();
      if (built) {
        const rotatedObstacleIndexSet = new Set(rotatedObstacleIndexes);
        detectedRotatedObstacleIndexes = [
          ...new Set(
            getTraceClearanceViolations(probeProblem, built).flatMap(
              (violation) =>
                violation.kind === "obstacle" &&
                violation.obstacleIndex !== undefined &&
                rotatedObstacleIndexSet.has(violation.obstacleIndex)
                  ? [violation.obstacleIndex]
                  : [],
            ),
          ),
        ];
      }
    }
    this.output =
      detectedRotatedObstacleIndexes.length > 0
        ? buildBiscuitBoardHypergraph(
            this.input,
            this.options,
            new Set(detectedRotatedObstacleIndexes),
            buildTimings,
          )
        : nominalProblem;
    this.stats = {
      graphNodeCount: this.output.nodes.length,
      graphEdgeCount: this.output.edges.length,
      graphConflictReferenceCount:
        this.output.compactConflictEdgeIds?.length ??
        this.output.edges.reduce(
          (count, edge) =>
            count + (edge.kind === "trace" ? edge.conflictEdgeIds.length : 0),
          0,
        ),
      graphMaximumConflictCount: this.output.edges.reduce((maximum, edge) => {
        if (edge.kind !== "trace") return maximum;
        const offsets = this.output!.conflictOffsets;
        const count = offsets
          ? offsets[edge.edgeId + 1]! - offsets[edge.edgeId]!
          : edge.conflictEdgeIds.length;
        return Math.max(maximum, count);
      }, 0),
      graphBlockingObstacleReferenceCount: this.output.edges.reduce(
        (count, edge) =>
          count +
          (edge.kind === "trace" ? edge.blockingObstacleIndexes.length : 0),
        0,
      ),
      graphStructureBuildDurationMs: Math.round(buildTimings.structureMs),
      graphConflictCollectionDurationMs: Math.round(
        buildTimings.conflictCollectionMs,
      ),
      graphConflictCompactionDurationMs: Math.round(
        buildTimings.conflictCompactionMs,
      ),
      graphConflictCandidateCount: buildTimings.conflictCandidateCount,
      graphConflictUniqueCandidateCount:
        buildTimings.conflictUniqueCandidateCount,
      graphConflictDistanceCheckCount: buildTimings.conflictDistanceCheckCount,
      graphConflictBucketEntryCount: buildTimings.conflictBucketEntryCount,
      graphConflictWorkerCount: buildTimings.conflictWorkerCount,
      graphFinalizationDurationMs: Math.round(buildTimings.finalizationMs),
      graphRotatedObstacleProbeDurationMs: Math.round(
        performance.now() - rotatedObstacleProbeStartedAt,
      ),
      graphBuildCount: buildTimings.buildCount,
      prefabricatedViaCount: this.output.prefabricatedVias.length,
      automaticallyReservedRotatedObstacleCount:
        detectedRotatedObstacleIndexes.length,
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
      : visualizeSimpleRouteJsonInput(this.input);
  }
}

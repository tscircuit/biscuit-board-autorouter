import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import {
  getTerminalEscapeMinimumRun,
  obstacleBounds,
  pointDistance,
  segmentDistance,
  segmentIntersectsRectInterior,
  shouldRespectObstacleRotationInGraph,
  visualizePreparedProblem,
} from "./geometry";
import { MinHeap } from "./min-heap";
import type {
  BiscuitBoardRoutingSolution,
  BiscuitBoardRoutingStats,
  Point,
  PreparedBiscuitRoutingProblem,
  RouteDemand,
  RoutedConnection,
  RoutingEdge,
} from "./types";

interface SearchNode {
  graphNode: number;
  stateKey: number;
  blockerState: number;
  g: number;
  parentIndex: number;
  blockers: number[];
  edgeFromParent: number | null;
  visitedPreferredLayer: boolean;
  requiredViaIndex: number;
  requiredGuideIndex: number;
}

interface ActiveSearch {
  demand: RouteDemand;
  allowBlockers: boolean;
  collapseBlockerStates: boolean;
  sourceNode: number;
  targetNodes: Set<number>;
  targetTreesByLayer: Map<string, TargetKdNode | null>;
  targetHeuristicGeneration: number;
  heuristicWeight: number;
  nodes: SearchNode[];
  open: MinHeap<number>;
  bestCostByState: Map<number, number>;
  expanded: number;
  // Values that cannot change while this search is active, hoisted out of the
  // per-edge inner loop.
  requiredPrefabViaIds: string[];
  requiredViaCount: number;
  requiredGuideTarget: number;
  escapeConstraints: TerminalEscapeConstraint[];
  routeEdgeHistory: Map<number, number> | undefined;
  layerPenalties: Map<string, number> | undefined;
  preferredLayer: string | undefined;
  congestionCost: number;
  sourcePoint: Point;
  targetPoint: Point;
  directCorridorPenaltyScale: number;
  preferredLayerCorridorBonusScale: number;
  demandCacheKey: number;
  foreignOwnerCacheGeneration: number;
  foreignOwnerCacheEntryCount: number;
  protectedCorridors: Array<{
    from: Point;
    to: Point;
    minimumDistance: number;
  }>;
}

interface TargetKdNode {
  x: number;
  y: number;
  axis: 0 | 1;
  left: TargetKdNode | null;
  right: TargetKdNode | null;
}

interface TerminalEscapeConstraint {
  terminalNode: number;
  axis: "x" | "y";
  direction: -1 | 1;
  minimumRun: number;
}

const buildTargetKdTree = (
  points: Array<{ x: number; y: number }>,
  depth = 0,
): TargetKdNode | null => {
  if (points.length === 0) return null;
  const axis = (depth % 2) as 0 | 1;
  const coordinate = axis === 0 ? "x" : "y";
  points.sort(
    (left, right) =>
      left[coordinate] - right[coordinate] ||
      left.x - right.x ||
      left.y - right.y,
  );
  const middle = Math.floor(points.length / 2);
  const point = points[middle]!;
  return {
    x: point.x,
    y: point.y,
    axis,
    left: buildTargetKdTree(points.slice(0, middle), depth + 1),
    right: buildTargetKdTree(points.slice(middle + 1), depth + 1),
  };
};

const nearestTargetDistanceSquared = (
  tree: TargetKdNode | null,
  x: number,
  y: number,
  bestDistanceSquared = Number.POSITIVE_INFINITY,
): number => {
  if (!tree) return bestDistanceSquared;
  const dx = x - tree.x;
  const dy = y - tree.y;
  let best = Math.min(bestDistanceSquared, dx * dx + dy * dy);
  if (tree.left === null && tree.right === null) return best;
  const axisDifference = tree.axis === 0 ? dx : dy;
  const nearBranch = axisDifference <= 0 ? tree.left : tree.right;
  const farBranch = axisDifference <= 0 ? tree.right : tree.left;
  best = nearestTargetDistanceSquared(nearBranch, x, y, best);
  if (axisDifference * axisDifference < best) {
    best = nearestTargetDistanceSquared(farBranch, x, y, best);
  }
  return best;
};

const insertSortedUnique = (values: number[], additions: number[]) => {
  if (additions.length === 0) return values;
  if (values.length === 0) return additions;
  const merged: number[] = [];
  let valueIndex = 0;
  let additionIndex = 0;
  while (valueIndex < values.length || additionIndex < additions.length) {
    const value = values[valueIndex];
    const addition = additions[additionIndex];
    let next: number;
    if (addition === undefined || (value !== undefined && value < addition)) {
      next = values[valueIndex++]!;
    } else if (value === undefined || addition < value) {
      next = additions[additionIndex++]!;
    } else {
      next = value;
      valueIndex++;
      additionIndex++;
    }
    if (merged.at(-1) !== next) merged.push(next);
  }
  return merged;
};

const blockerSetHash = (blockers: readonly number[]) => {
  let hash = 2166136261;
  for (const blockerIndex of blockers) {
    hash ^= blockerIndex + 1;
    hash = Math.imul(hash, 16777619);
  }
  // A small lossy blocker-state table bounds the A* state count while keeping
  // enough distinct rip choices to escape fixed-via allocation deadlocks.
  return hash & 1;
};

const deterministicOrderKey = (value: string, pass: number) => {
  let hash = (2166136261 ^ pass) >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
};

// Prefer enough room for the requested final width around immovable pads,
// while keeping the physical-width route available as a congestion fallback.
const NOMINAL_OBSTACLE_PENALTY_MULTIPLIER = 10;
const NO_BLOCKERS: number[] = [];
const NO_OWNED_NODES = new Set<number>();

export class RipUpRubberBandSolver extends BaseSolver {
  private readonly committed = new Map<string, RoutedConnection>();
  private readonly pending: RouteDemand[];
  private readonly inputIndexByDemand = new WeakMap<RouteDemand, number>();
  private readonly edgeOwners = new Map<number, Set<number>>();
  private readonly nodeOwners = new Map<number, Set<number>>();
  private readonly edgeHasOwners: Uint8Array;
  private readonly nodeHasOwners: Uint8Array;
  private readonly routeDependenciesByRoute = new Map<string, Set<string>>();
  private readonly historyCostByEdge: Float64Array;
  private readonly historyCostByNode: Float64Array;
  private readonly historyCostByRouteEdge = new Map<
    string,
    Map<number, number>
  >();
  private readonly layerPenaltyByRoute = new Map<string, Map<string, number>>();
  private readonly preferredLayerByRoute = new Map<string, string>();
  private readonly requiredPrefabViaIdsByRoute = new Map<string, string[]>();
  private readonly reservedPrefabViaOwnerById = new Map<string, string>();
  private readonly exhaustedPrefabViaBridgeRouteIds = new Set<string>();
  private readonly requiredGuideCountByConnectionName = new Map<
    string,
    number
  >();
  private readonly forcedGuideConnectionNames = new Set<string>();
  private readonly reservedGuideOwnerByEdgeId = new Map<number, string>();
  private readonly routeIndexById: Map<string, number>;
  private readonly routeIdByIndex: string[];
  private readonly routeIndexByDemand = new WeakMap<RouteDemand, number>();
  private readonly netIndexByRoute: Uint32Array;
  private readonly widthByRoute: Float64Array;
  private readonly ripCountByRoute: Uint32Array;
  private readonly conflictComponentAttemptCount = new Map<string, number>();
  private readonly terminalEscapeConstraintsByDemand = new WeakMap<
    RouteDemand,
    TerminalEscapeConstraint[]
  >();
  private readonly protectedCorridorsByDemand = new WeakMap<
    RouteDemand,
    ActiveSearch["protectedCorridors"]
  >();
  // Direct-mapped demand caches keep one bounded graph-sized buffer per
  // property instead of retaining one full buffer for every route demand.
  private readonly demandCacheKeyByDemand = new WeakMap<RouteDemand, number>();
  private nextDemandCacheKey = 1;
  private readonly edgeAllowanceCacheKeys: Uint32Array;
  private readonly edgeAllowanceCacheValues: Uint8Array;
  private readonly nodeAllowanceCacheKeys: Uint32Array;
  private readonly nodeAllowanceCacheValues: Uint8Array;
  private readonly escapeTraversalCacheKeys: Uint32Array;
  private readonly escapeTraversalCacheValues: Uint8Array;
  private readonly fanoutPenaltyCacheKeys: Uint32Array;
  private readonly fanoutPenaltyCacheValues: Float64Array;
  private readonly geometryPenaltyCacheKeys: Uint32Array;
  private readonly geometryPenaltyCacheValues: Float64Array;
  private readonly nominalObstaclePenaltyCacheKeys: Uint32Array;
  private readonly nominalObstaclePenaltyCacheValues: Float64Array;
  private readonly foreignOwnerCacheGenerationByEdge: Uint32Array;
  private readonly foreignOwnerCacheValues: Array<number[] | undefined>;
  private nextForeignOwnerCacheGeneration = 1;
  // The center-to-center distance between a trace edge and each entry in its
  // conflictEdgeIds list is immutable topology; computing it once removes the
  // dominant geometry cost from the A* inner loop.
  private readonly conflictDistancesByEdge = new Map<number, Float64Array>();
  private readonly conflictOffsets: Uint32Array | undefined;
  private readonly compactConflictEdgeIds: Uint32Array | undefined;
  // Incremental clearance occupancy: for each trace edge, which committed
  // routes have copper within the generator's conflict radius, and at which
  // center-to-center distances. Updated on commit/uncommit so the A* loop
  // never rescans conflict lists.
  private readonly occupancyByEdge = new Map<number, Map<number, number[]>>();
  private readonly edgeHasConflictOccupancy: Uint8Array;
  private readonly ownedNodeCountByNet = new Map<string, Map<number, number>>();
  private readonly ownedNodesByNet = new Map<string, Set<number>>();
  private readonly effectiveClearance: number;
  private readonly routingScale: number;
  private readonly targetHeuristicByNode: Float64Array;
  private readonly targetHeuristicGenerationByNode: Uint32Array;
  private targetHeuristicGeneration = 0;
  private committedFixedViaTransitionCount = 0;
  private activeSearch: ActiveSearch | null = null;
  private maximumActiveSearchNodeCount = 0;
  private maximumOpenHeapSize = 0;
  private searchCount = 0;
  private failedSearchCount = 0;
  private maximumForeignOwnerCacheEntries = 0;
  private nodeAllowanceCacheHitCount = 0;
  private nodeAllowanceCacheMissCount = 0;
  private edgeAllowanceCacheHitCount = 0;
  private edgeAllowanceCacheMissCount = 0;
  private foreignOwnerCacheHitCount = 0;
  private foreignOwnerCacheMissCount = 0;
  private targetHeuristicCacheHitCount = 0;
  private targetHeuristicCacheMissCount = 0;
  private maximumHeuristicWeightUsed = 1;
  private connectivityRepairCount = 0;
  private totalRipCount = 0;
  private totalExpandedStateCount = 0;
  private negotiationPassCount = 0;
  private lastConflictRouteCount = 0;
  private lastConflictComponents: string[][] = [];
  private adaptivePriorityChangeCount = 0;

  constructor(public readonly prepared: PreparedBiscuitRoutingProblem) {
    super();
    // Numeric ordering matches the previous lexical blocker ordering so the
    // compact representation does not perturb negotiation solely by ID shape.
    this.routeIdByIndex = prepared.demands
      .map((demand) => demand.routeId)
      .sort();
    this.routeIndexById = new Map(
      this.routeIdByIndex.map((routeId, routeIndex) => [routeId, routeIndex]),
    );
    const netIndexById = new Map<string, number>();
    this.netIndexByRoute = new Uint32Array(prepared.demands.length);
    this.widthByRoute = new Float64Array(prepared.demands.length);
    this.ripCountByRoute = new Uint32Array(prepared.demands.length);
    for (const demand of prepared.demands) {
      const routeIndex = this.routeIndexById.get(demand.routeId)!;
      let netIndex = netIndexById.get(demand.netId);
      if (netIndex === undefined) {
        netIndex = netIndexById.size;
        netIndexById.set(demand.netId, netIndex);
      }
      this.routeIndexByDemand.set(demand, routeIndex);
      this.netIndexByRoute[routeIndex] = netIndex;
      this.widthByRoute[routeIndex] = demand.width;
    }
    this.effectiveClearance = Math.max(
      prepared.options.gridClearance,
      prepared.input.minTraceToPadEdgeClearance ?? 0,
    );
    this.routingScale = Math.hypot(
      prepared.input.bounds.maxX - prepared.input.bounds.minX,
      prepared.input.bounds.maxY - prepared.input.bounds.minY,
    );
    this.targetHeuristicByNode = new Float64Array(prepared.nodes.length);
    this.targetHeuristicGenerationByNode = new Uint32Array(
      prepared.nodes.length,
    );
    this.edgeAllowanceCacheKeys = new Uint32Array(prepared.edges.length);
    this.edgeAllowanceCacheValues = new Uint8Array(prepared.edges.length);
    this.nodeAllowanceCacheKeys = new Uint32Array(prepared.nodes.length);
    this.nodeAllowanceCacheValues = new Uint8Array(prepared.nodes.length);
    this.escapeTraversalCacheKeys = new Uint32Array(prepared.edges.length);
    this.escapeTraversalCacheValues = new Uint8Array(prepared.edges.length);
    this.fanoutPenaltyCacheKeys = new Uint32Array(prepared.edges.length);
    this.fanoutPenaltyCacheValues = new Float64Array(prepared.edges.length);
    this.geometryPenaltyCacheKeys = new Uint32Array(prepared.edges.length);
    this.geometryPenaltyCacheValues = new Float64Array(prepared.edges.length);
    this.nominalObstaclePenaltyCacheKeys = new Uint32Array(
      prepared.edges.length,
    );
    this.nominalObstaclePenaltyCacheValues = new Float64Array(
      prepared.edges.length,
    );
    this.foreignOwnerCacheGenerationByEdge = new Uint32Array(
      prepared.edges.length,
    );
    this.foreignOwnerCacheValues = new Array(prepared.edges.length);
    this.edgeHasOwners = new Uint8Array(prepared.edges.length);
    this.nodeHasOwners = new Uint8Array(prepared.nodes.length);
    this.edgeHasConflictOccupancy = new Uint8Array(prepared.edges.length);
    this.conflictOffsets = prepared.conflictOffsets;
    this.compactConflictEdgeIds = prepared.compactConflictEdgeIds;
    this.historyCostByEdge = new Float64Array(prepared.edges.length);
    this.historyCostByNode = new Float64Array(prepared.nodes.length);
    const compareByDistance = (left: RouteDemand, right: RouteDemand) => {
      const leftDistance = pointDistance(
        prepared.nodes[left.sourceNode]!,
        prepared.nodes[left.targetNode]!,
      );
      const rightDistance = pointDistance(
        prepared.nodes[right.sourceNode]!,
        prepared.nodes[right.targetNode]!,
      );
      const comparison =
        rightDistance - leftDistance ||
        prepared.demands.indexOf(left) - prepared.demands.indexOf(right);
      return prepared.options.routeOrder === "shortest_first"
        ? -comparison
        : comparison;
    };
    this.pending = prepared.demands.slice();
    for (const edge of prepared.edges) {
      if (
        edge.kind === "trace" &&
        edge.restrictedToConnectionName !== undefined &&
        edge.restrictedGuideCount !== undefined
      ) {
        this.requiredGuideCountByConnectionName.set(
          edge.restrictedToConnectionName,
          edge.restrictedGuideCount,
        );
        this.forcedGuideConnectionNames.add(edge.restrictedToConnectionName);
        const guideOwnerNetId = prepared.demands.find(
          (demand) => demand.connectionName === edge.restrictedToConnectionName,
        )?.netId;
        if (!guideOwnerNetId) continue;
        this.reservedGuideOwnerByEdgeId.set(edge.edgeId, guideOwnerNetId);
        const conflictCount = this.getConflictCount(edge);
        for (let index = 0; index < conflictCount; index++) {
          const reservedEdgeId = this.getConflictEdgeId(edge, index);
          this.reservedGuideOwnerByEdgeId.set(reservedEdgeId, guideOwnerNetId);
        }
      }
    }
    if (
      prepared.options.routeOrder === "adaptive" ||
      prepared.options.routeOrder === "signal_longest_first"
    ) {
      this.pending.sort((left, right) => {
        const leftIsPointToPoint = left.connectionTerminalCount === 2;
        const rightIsPointToPoint = right.connectionTerminalCount === 2;
        if (leftIsPointToPoint !== rightIsPointToPoint) {
          return leftIsPointToPoint ? -1 : 1;
        }
        return leftIsPointToPoint
          ? compareByDistance(left, right)
          : prepared.demands.indexOf(left) - prepared.demands.indexOf(right);
      });
    } else if (prepared.options.routeOrder !== "input") {
      this.pending.sort(compareByDistance);
    }
    this.pending = this.groupDemandsByNet(this.pending);
    for (let index = 0; index < this.pending.length; index++) {
      this.inputIndexByDemand.set(this.pending[index]!, index);
    }
    this.initializeFinePitchLayerAssignments();
    this.rejectImpracticalBottomLayerPreferences();
    const maximumRoutingAttempts =
      prepared.demands.length + prepared.options.maxTotalRips + 1;
    const stepsPerSearch = Math.ceil(
      prepared.options.maxSearchStates / prepared.options.expansionsPerStep,
    );
    this.MAX_ITERATIONS = Math.max(
      1_000,
      maximumRoutingAttempts * (stepsPerSearch + 2),
    );
    this.updateStats();
  }

  override getConstructorParams(): [PreparedBiscuitRoutingProblem] {
    return [this.prepared];
  }

  get committedRoutes() {
    return new Map(this.committed);
  }

  get activeDemand() {
    return this.activeSearch?.demand ?? null;
  }

  get negotiationConflictComponents() {
    return this.lastConflictComponents.map((component) => [...component]);
  }

  /**
   * Reuses a completed routing as the starting point for a localized
   * rip-and-replace repair. The node and edge indexes must belong to this
   * solver's prepared graph.
   */
  seedCommittedRoutes(
    routes: readonly RoutedConnection[],
    routeIdsToReroute: readonly string[],
  ) {
    if (this.committed.size > 0 || this.activeSearch) {
      throw new Error("Cannot seed a routing solver after routing has started");
    }
    this.pending.splice(0);
    for (const route of routes) this.installSeededRoute(route);
    for (const routeId of routeIdsToReroute) {
      this.uncommitRoute(routeId);
      this.queueDemand(routeId);
    }
    this.totalRipCount = 0;
    this.ripCountByRoute.fill(0);
    this.updateStats();
  }

  private installSeededRoute(route: RoutedConnection) {
    const routeIndex = this.routeIndexById.get(route.routeId);
    if (routeIndex === undefined) {
      throw new Error(`Cannot seed unknown route "${route.routeId}"`);
    }
    const dependencies = new Set<string>();
    for (const endpointNode of [route.nodePath[0], route.nodePath.at(-1)]) {
      if (endpointNode === undefined) continue;
      for (const ownerRouteIndex of this.nodeOwners.get(endpointNode) ?? []) {
        const ownerRouteId = this.routeIdByIndex[ownerRouteIndex]!;
        if (this.committed.get(ownerRouteId)?.netId === route.netId) {
          dependencies.add(ownerRouteId);
        }
      }
    }
    this.committed.set(route.routeId, route);
    this.routeDependenciesByRoute.set(route.routeId, dependencies);
    const ownedNodeCounts =
      this.ownedNodeCountByNet.get(route.netId) ?? new Map<number, number>();
    this.ownedNodeCountByNet.set(route.netId, ownedNodeCounts);
    const ownedNodes =
      this.ownedNodesByNet.get(route.netId) ?? new Set<number>();
    this.ownedNodesByNet.set(route.netId, ownedNodes);
    for (const nodeIndex of route.nodePath) {
      const owners = this.nodeOwners.get(nodeIndex) ?? new Set<number>();
      owners.add(routeIndex);
      this.nodeOwners.set(nodeIndex, owners);
      this.nodeHasOwners[nodeIndex] = 1;
      ownedNodeCounts.set(nodeIndex, (ownedNodeCounts.get(nodeIndex) ?? 0) + 1);
      ownedNodes.add(nodeIndex);
    }
    for (const edgeId of route.edgePath) {
      const edge = this.prepared.edges[edgeId]!;
      if (edge.kind !== "trace") {
        this.committedFixedViaTransitionCount++;
        continue;
      }
      const owners = this.edgeOwners.get(edgeId) ?? new Set<number>();
      owners.add(routeIndex);
      this.edgeOwners.set(edgeId, owners);
      this.edgeHasOwners[edgeId] = 1;
      const conflictDistances = this.getConflictDistances(edge);
      const conflictCount = this.getConflictCount(edge);
      for (let index = 0; index < conflictCount; index++) {
        const conflictEdgeId = this.getConflictEdgeId(edge, index);
        const occupancy =
          this.occupancyByEdge.get(conflictEdgeId) ??
          new Map<number, number[]>();
        this.occupancyByEdge.set(conflictEdgeId, occupancy);
        this.edgeHasConflictOccupancy[conflictEdgeId] = 1;
        const distances = occupancy.get(routeIndex) ?? [];
        distances.push(conflictDistances[index]!);
        occupancy.set(routeIndex, distances);
      }
    }
  }

  private groupDemandsByNet(demands: RouteDemand[]) {
    const netOrder: string[] = [];
    const demandsByNet = new Map<string, RouteDemand[]>();
    for (const demand of demands) {
      if (!demandsByNet.has(demand.netId)) netOrder.push(demand.netId);
      const netDemands = demandsByNet.get(demand.netId) ?? [];
      netDemands.push(demand);
      demandsByNet.set(demand.netId, netDemands);
    }
    return netOrder.flatMap((netId) => demandsByNet.get(netId) ?? []);
  }

  override _step() {
    if (!this.activeSearch) {
      const demand = this.takeNextDemand();
      if (!demand) {
        this.finishOrScheduleNegotiationPass();
        return;
      }
      if (this.committed.has(demand.routeId)) {
        this.uncommitRoute(demand.routeId);
        if (this.failed) return;
      }
      this.activeSearch = this.createSearch(demand, false);
    }

    for (
      let expansion = 0;
      expansion < this.prepared.options.expansionsPerStep;
      expansion++
    ) {
      if (!this.activeSearch || this.failed || this.solved) break;
      this.expandOneState();
    }
    this.progress =
      this.prepared.demandById.size === 0
        ? 1
        : this.committed.size / this.prepared.demandById.size;
    this.updateStats();
  }

  /**
   * Select the most constrained pending demand using only routing state and
   * topology. Recomputing this priority after every commit lets occupancy and
   * congestion history change the order instead of switching between static
   * longest- and shortest-first passes.
   */
  private takeNextDemand() {
    if (
      this.prepared.options.routeOrder !== "adaptive" ||
      this.pending.length < 2
    ) {
      return this.pending.shift();
    }

    // A ripped demand's position is already the output of conflict-component
    // negotiation; reshuffling it can recreate the same local cycle. Fresh
    // work adapts within a bounded topology-ordered window so congestion can
    // influence priority without starving another net.
    if (
      this.ripCountByRoute[this.routeIndexByDemand.get(this.pending[0]!)!]! > 0
    ) {
      return this.pending.shift();
    }
    let bestIndex = 0;
    const lookahead = Math.min(8, this.pending.length);
    for (let index = 1; index < lookahead; index++) {
      if (
        this.ripCountByRoute[
          this.routeIndexByDemand.get(this.pending[index]!)!
        ]! > 0
      )
        break;
      if (
        this.compareAdaptivePriority(
          this.pending[index]!,
          this.pending[bestIndex]!,
        ) < 0
      ) {
        bestIndex = index;
      }
    }
    if (bestIndex > 0) this.adaptivePriorityChangeCount++;
    return this.pending.splice(bestIndex, 1)[0];
  }

  private compareAdaptivePriority(left: RouteDemand, right: RouteDemand) {
    const leftPriority = this.getAdaptivePriority(left);
    const rightPriority = this.getAdaptivePriority(right);
    return (
      rightPriority.score - leftPriority.score ||
      leftPriority.inputIndex - rightPriority.inputIndex
    );
  }

  private getAdaptivePriority(demand: RouteDemand) {
    const ownedNodes = this.getOwnedNodesForNet(demand.netId);
    let freeEndpointChoices = 0;
    let historyPressure = 0;
    for (const nodeIndex of [demand.sourceNode, demand.targetNode]) {
      for (const adjacent of this.prepared.adjacency[nodeIndex]!) {
        const edge = this.prepared.edges[adjacent.edgeId]!;
        historyPressure +=
          this.historyCostByEdge[adjacent.edgeId]! +
          this.historyCostByNode[adjacent.toNode]!;
        if (
          this.nodeAllowsDemand(adjacent.toNode, demand) &&
          this.edgeAllowsDemand(edge, demand) &&
          this.getForeignOwners(edge, demand).length === 0
        ) {
          freeEndpointChoices++;
        }
      }
    }
    const startedNet = ownedNodes.size > 0 ? 1 : 0;
    const congestionPressure =
      historyPressure / Math.max(1, freeEndpointChoices);
    const topologyOrder = this.inputIndexByDemand.get(demand) ?? 0;
    return {
      score:
        -topologyOrder * this.routingScale * 2 +
        startedNet * this.routingScale * 4 +
        (this.prepared.options.gridPitch * 4) / (freeEndpointChoices + 1) +
        congestionPressure * 0.05,
      freeEndpointChoices,
      historyPressure,
      inputIndex: topologyOrder,
    };
  }

  private createSearch(
    demand: RouteDemand,
    allowBlockers: boolean,
  ): ActiveSearch {
    this.searchCount++;
    const collapseBlockerStates =
      allowBlockers && this.prepared.demands.length >= 64;
    const ownedNodesForNet = this.getOwnedNodesForNet(demand.netId);
    const sourceIsOwned = ownedNodesForNet.has(demand.sourceNode);
    const targetIsOwned = ownedNodesForNet.has(demand.targetNode);
    let sourceNode = demand.sourceNode;
    let targetNodes = new Set([demand.targetNode]);
    if (ownedNodesForNet.size > 0) {
      if (sourceIsOwned && !targetIsOwned) {
        sourceNode = demand.targetNode;
        targetNodes = ownedNodesForNet;
      } else if (!sourceIsOwned && targetIsOwned) {
        targetNodes = ownedNodesForNet;
      } else if (sourceIsOwned && targetIsOwned) {
        const ownedComponents = this.getOwnedComponentsForNet(demand.netId);
        const sourceComponent = ownedComponents.find((component) =>
          component.has(demand.sourceNode),
        );
        const targetComponent = ownedComponents.find((component) =>
          component.has(demand.targetNode),
        );
        targetNodes =
          sourceComponent === targetComponent
            ? new Set([demand.sourceNode])
            : (targetComponent ?? new Set([demand.targetNode]));
      }
    }
    const targetPointsByLayer = new Map<
      string,
      Array<{ x: number; y: number }>
    >();
    for (const nodeIndex of targetNodes) {
      const target = this.prepared.nodes[nodeIndex]!;
      const points = targetPointsByLayer.get(target.layer) ?? [];
      points.push(target);
      targetPointsByLayer.set(target.layer, points);
    }
    const targetTreesByLayer = new Map<string, TargetKdNode | null>();
    for (const [layer, points] of targetPointsByLayer) {
      targetTreesByLayer.set(layer, buildTargetKdTree(points));
    }
    this.targetHeuristicGeneration = (this.targetHeuristicGeneration + 1) >>> 0;
    if (this.targetHeuristicGeneration === 0) {
      this.targetHeuristicGenerationByNode.fill(0);
      this.targetHeuristicGeneration = 1;
    }
    const targetHeuristicGeneration = this.targetHeuristicGeneration;
    const heuristicWeight =
      this.prepared.options.routeOrder !== "adaptive" ||
      this.prepared.demands.length >= 64
        ? 1
        : Math.min(
            this.prepared.options.maxHeuristicWeight,
            this.prepared.options.heuristicWeight +
              this.negotiationPassCount * 0.05,
          );
    this.maximumHeuristicWeightUsed = Math.max(
      this.maximumHeuristicWeightUsed,
      heuristicWeight,
    );
    const open = new MinHeap<number>();
    open.push(
      heuristicWeight *
        this.heuristicToTargets(
          sourceNode,
          targetTreesByLayer,
          targetHeuristicGeneration,
        ),
      0,
    );
    const preferredLayer = this.preferredLayerByRoute.get(demand.routeId);
    const sourceVisitedPreferredLayer =
      preferredLayer === undefined ||
      this.prepared.nodes[sourceNode]!.layer === preferredLayer;
    const requiredPrefabViaIds =
      this.requiredPrefabViaIdsByRoute.get(demand.routeId) ?? [];
    const sourcePoint = this.prepared.nodes[demand.sourceNode]!;
    const targetPoint = this.prepared.nodes[demand.targetNode]!;
    const escapeConstraints = this.getTerminalEscapeConstraints(demand);
    const directDistance = pointDistance(sourcePoint, targetPoint);
    const isShallowEscapeCorridor = this.isShallowEscapeCorridor(
      demand,
      escapeConstraints,
    );
    const protectedCorridors = this.getProtectedCorridors(
      demand,
      directDistance,
    );
    const directCorridorPenaltyScale =
      demand.connectionTerminalCount === 2 &&
      escapeConstraints.length > 0 &&
      directDistance <= 10 &&
      !this.requiredPrefabViaIdsByRoute.has(demand.routeId)
        ? 4
        : 0;
    const preferredLayerCorridorBonusScale = isShallowEscapeCorridor
      ? this.requiredPrefabViaIdsByRoute.has(demand.routeId)
        ? 8
        : 4
      : 0;
    const initialStateKey = this.stateKey(
      sourceNode,
      null,
      collapseBlockerStates ? 3 : 0,
      sourceVisitedPreferredLayer,
      0,
      0,
    );
    const initialNode: SearchNode = {
      graphNode: sourceNode,
      stateKey: initialStateKey,
      blockerState: collapseBlockerStates ? 3 : 0,
      g: 0,
      parentIndex: -1,
      blockers: NO_BLOCKERS,
      edgeFromParent: null,
      visitedPreferredLayer: sourceVisitedPreferredLayer,
      requiredViaIndex: 0,
      requiredGuideIndex: 0,
    };
    return {
      demand,
      allowBlockers,
      collapseBlockerStates,
      sourceNode,
      targetNodes,
      targetTreesByLayer,
      targetHeuristicGeneration,
      heuristicWeight,
      nodes: [initialNode],
      open,
      bestCostByState: new Map([[initialStateKey, 0]]),
      expanded: 0,
      requiredPrefabViaIds,
      requiredViaCount: requiredPrefabViaIds.length,
      requiredGuideTarget: this.forcedGuideConnectionNames.has(
        demand.connectionName,
      )
        ? (this.requiredGuideCountByConnectionName.get(demand.connectionName) ??
          0)
        : 0,
      escapeConstraints,
      routeEdgeHistory: this.historyCostByRouteEdge.get(demand.routeId),
      layerPenalties: this.layerPenaltyByRoute.get(demand.routeId),
      preferredLayer,
      congestionCost:
        this.prepared.options.ripCost * (this.negotiationPassCount + 1) ** 2,
      sourcePoint,
      targetPoint,
      directCorridorPenaltyScale,
      preferredLayerCorridorBonusScale,
      demandCacheKey: this.getDemandCacheKey(demand),
      foreignOwnerCacheGeneration: this.nextForeignOwnerCacheGeneration++,
      foreignOwnerCacheEntryCount: 0,
      protectedCorridors,
    };
  }

  private getProtectedCorridors(demand: RouteDemand, directDistance: number) {
    const cached = this.protectedCorridorsByDemand.get(demand);
    if (cached) return cached;
    const sourcePoint = this.prepared.nodes[demand.sourceNode]!;
    const targetPoint = this.prepared.nodes[demand.targetNode]!;
    const protectedCorridors = this.prepared.demands.flatMap((candidate) => {
      if (
        demand.connectionTerminalCount <= 2 ||
        demand.connectionTerminalCount > 4 ||
        directDistance < this.prepared.options.gridPitch * 4 ||
        candidate.connectionTerminalCount !== 2 ||
        candidate.netId === demand.netId
      ) {
        return [];
      }
      const from = this.prepared.nodes[candidate.sourceNode]!;
      const to = this.prepared.nodes[candidate.targetNode]!;
      const candidateDistance = pointDistance(from, to);
      if (
        candidateDistance < this.prepared.options.gridPitch * 2 ||
        candidateDistance > this.prepared.options.gridPitch * 3 ||
        segmentDistance(sourcePoint, targetPoint, from, to) > 1e-7
      ) {
        return [];
      }
      const minimumDistance = Math.max(
        this.prepared.options.gridPitch / 2 -
          this.prepared.options.gridClearance / 2,
        demand.width / 2 + candidate.width / 2 + this.effectiveClearance,
      );
      return [{ from, to, minimumDistance }];
    });
    this.protectedCorridorsByDemand.set(demand, protectedCorridors);
    return protectedCorridors;
  }

  private getOwnedNodesForNet(netId: string) {
    return this.ownedNodesByNet.get(netId) ?? NO_OWNED_NODES;
  }

  private getOwnedComponentsForNet(netId: string) {
    const parent = new Map<number, number>();
    const find = (node: number): number => {
      const currentParent = parent.get(node) ?? node;
      parent.set(node, currentParent);
      if (currentParent === node) return node;
      const root = find(currentParent);
      parent.set(node, root);
      return root;
    };
    const union = (left: number, right: number) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    for (const route of this.committed.values()) {
      if (route.netId !== netId || route.nodePath.length === 0) continue;
      const firstNode = route.nodePath[0]!;
      find(firstNode);
      for (const node of route.nodePath.slice(1)) union(firstNode, node);
    }
    const componentsByRoot = new Map<number, Set<number>>();
    for (const node of parent.keys()) {
      const root = find(node);
      const component = componentsByRoot.get(root) ?? new Set<number>();
      component.add(node);
      componentsByRoot.set(root, component);
    }
    return [...componentsByRoot.values()];
  }

  private stateKey(
    graphNode: number,
    edgeFromParent: number | null,
    blockerState: number,
    visitedPreferredLayer = true,
    requiredViaIndex = 0,
    requiredGuideIndex = 0,
  ) {
    // Packed numeric key: same state identity as the previous string key, but
    // cheap enough to build in the A* inner loop.
    const node = this.prepared.nodes[graphNode]!;
    const arrivalKind =
      node.kind !== "fixed_via"
        ? 0
        : edgeFromParent === null
          ? 1
          : this.prepared.edges[edgeFromParent]!.kind === "trace"
            ? 2
            : 3;
    return (
      ((((graphNode * 4 + arrivalKind) * 4 + blockerState) * 2 +
        (visitedPreferredLayer ? 1 : 0)) *
        8 +
        (requiredViaIndex + 2)) *
        64 +
      requiredGuideIndex
    );
  }

  private heuristic(fromNode: number, toNode: number) {
    const from = this.prepared.nodes[fromNode]!;
    const to = this.prepared.nodes[toNode]!;
    return (
      pointDistance(from, to) +
      (from.layer === to.layer ? 0 : this.prepared.options.viaTransitionCost)
    );
  }

  private heuristicToTargets(
    fromNode: number,
    targetTreesByLayer: ActiveSearch["targetTreesByLayer"],
    cacheGeneration: number,
  ) {
    if (this.targetHeuristicGenerationByNode[fromNode] === cacheGeneration) {
      this.targetHeuristicCacheHitCount++;
      return this.targetHeuristicByNode[fromNode]!;
    }
    this.targetHeuristicCacheMissCount++;
    const from = this.prepared.nodes[fromNode]!;
    let best = Number.POSITIVE_INFINITY;
    for (const [layer, tree] of targetTreesByLayer) {
      const distance = Math.sqrt(
        nearestTargetDistanceSquared(tree, from.x, from.y),
      );
      best = Math.min(
        best,
        distance +
          (layer === from.layer ? 0 : this.prepared.options.viaTransitionCost),
      );
    }
    this.targetHeuristicByNode[fromNode] = best;
    this.targetHeuristicGenerationByNode[fromNode] = cacheGeneration;
    return best;
  }

  private expandOneState() {
    const search = this.activeSearch;
    if (!search) return;
    const searchNodeIndex = search.open.pop();
    if (searchNodeIndex === undefined) {
      this.failedSearchCount++;
      if (!search.allowBlockers) {
        // Most routes have a free path, frequently by using the bottom layer
        // through fixed vias. Searching that zero-blocker state space first
        // avoids the combinatorial blocker subsets that tiny-hypergraph also
        // treats as an exceptional rip/re-route phase.
        this.activeSearch = this.createSearch(search.demand, true);
        return;
      }
      let exhaustedRouteCount = 0;
      for (const ripCount of this.ripCountByRoute) {
        if (ripCount >= this.prepared.options.maxRipsPerRoute) {
          exhaustedRouteCount++;
        }
      }
      if (this.releasePrefabViaBridge(search.demand.routeId)) {
        this.activeSearch = this.createSearch(search.demand, true);
        return;
      }
      this.fail(
        `No fixed-via route found for "${search.demand.routeId}" with at most ${this.prepared.options.maxBlockersPerSearch} blockers${
          exhaustedRouteCount > 0
            ? `; ${exhaustedRouteCount} existing route(s) exhausted their rip budget`
            : ""
        }`,
      );
      return;
    }
    const current = search.nodes[searchNodeIndex]!;
    const bestCost = search.bestCostByState.get(current.stateKey);
    if (bestCost === undefined || current.g > bestCost + 1e-9) {
      return;
    }
    search.expanded++;
    this.totalExpandedStateCount++;

    if (
      search.targetNodes.has(current.graphNode) &&
      current.visitedPreferredLayer &&
      current.requiredViaIndex === search.requiredViaCount &&
      current.requiredGuideIndex === search.requiredGuideTarget
    ) {
      this.commitGoal(search, searchNodeIndex);
      return;
    }
    if (search.nodes.length >= this.prepared.options.maxSearchStates) {
      this.fail(
        `A* state limit (${this.prepared.options.maxSearchStates}) reached for "${search.demand.routeId}"`,
      );
      return;
    }

    for (const adjacent of this.prepared.adjacency[current.graphNode]!) {
      this.considerEdge(
        search,
        searchNodeIndex,
        adjacent.edgeId,
        adjacent.toNode,
      );
    }
  }

  private considerEdge(
    search: ActiveSearch,
    parentIndex: number,
    edgeId: number,
    toNode: number,
  ) {
    const parent = search.nodes[parentIndex]!;
    const edge = this.prepared.edges[edgeId]!;
    const parentEdge =
      parent.edgeFromParent === null
        ? null
        : this.prepared.edges[parent.edgeFromParent]!;
    const currentNode = this.prepared.nodes[parent.graphNode]!;
    const toNodeData = this.prepared.nodes[toNode]!;
    // Merely crossing an assignable via on one layer does not electrically
    // claim it in Circuit JSON. Once a route enters a prefab-via node through
    // copper, it must take the fixed layer transition before leaving.
    if (
      currentNode.kind === "fixed_via" &&
      parentEdge?.kind === "trace" &&
      edge.kind === "trace"
    ) {
      return;
    }
    const requiredPrefabViaIds = search.requiredPrefabViaIds;
    let requiredViaIndex = parent.requiredViaIndex;
    let requiredGuideIndex = parent.requiredGuideIndex;
    if (
      edge.kind === "trace" &&
      edge.restrictedGuideOrder !== undefined &&
      edge.restrictedToConnectionName === search.demand.connectionName
    ) {
      if (edge.restrictedGuideOrder !== requiredGuideIndex) return;
      requiredGuideIndex++;
    }
    if (edge.kind === "fixed_via_transition") {
      const reservedOwnerRouteId = this.reservedPrefabViaOwnerById.get(
        edge.prefabViaId,
      );
      const reservedOwnerDemand = reservedOwnerRouteId
        ? this.prepared.demandById.get(reservedOwnerRouteId)
        : undefined;
      if (
        reservedOwnerRouteId !== undefined &&
        reservedOwnerRouteId !== search.demand.routeId &&
        reservedOwnerDemand?.netId !== search.demand.netId
      ) {
        return;
      }
      const requiredIndex = requiredPrefabViaIds.indexOf(edge.prefabViaId);
      if (requiredPrefabViaIds.length === 2 && requiredIndex >= 0) {
        if (requiredViaIndex === 0) {
          requiredViaIndex = requiredIndex === 0 ? 1 : -1;
        } else if (requiredViaIndex === 1 && requiredIndex === 1) {
          requiredViaIndex = 2;
        } else if (requiredViaIndex === -1 && requiredIndex === 0) {
          requiredViaIndex = 2;
        } else {
          return;
        }
      } else {
        if (requiredIndex >= 0 && requiredIndex !== requiredViaIndex) return;
        if (requiredIndex === requiredViaIndex) requiredViaIndex++;
      }
    }
    if (search.escapeConstraints.length > 0) {
      // The escape verdict is symmetric in (from, to), so it caches per
      // undirected edge.
      let verdict: number;
      if (this.escapeTraversalCacheKeys[edgeId] === search.demandCacheKey) {
        verdict = this.escapeTraversalCacheValues[edgeId]!;
      } else {
        verdict = this.traversalFollowsTerminalEscapes(
          parent.graphNode,
          toNode,
          search.demand,
        )
          ? 1
          : 2;
        this.escapeTraversalCacheKeys[edgeId] = search.demandCacheKey;
        this.escapeTraversalCacheValues[edgeId] = verdict;
      }
      if (verdict === 2) return;
    }
    if (
      toNodeData.kind === "terminal" &&
      !this.nodeAllowsDemand(toNode, search.demand, search.demandCacheKey)
    ) {
      return;
    }
    if (
      edge.kind === "trace" &&
      (edge.restrictedToConnectionName !== undefined ||
        edge.blockingObstacleIndexes.length > 0 ||
        this.prepared.exactRotatedObstacleIndexes.length > 0) &&
      !this.edgeAllowsDemand(edge, search.demand, search.demandCacheKey)
    ) {
      return;
    }
    const reservedGuideOwner = this.reservedGuideOwnerByEdgeId.get(edgeId);
    if (
      reservedGuideOwner !== undefined &&
      reservedGuideOwner !== search.demand.netId
    ) {
      return;
    }

    let foreignOwnerIndexes: number[];
    if (
      this.foreignOwnerCacheGenerationByEdge[edgeId] ===
      search.foreignOwnerCacheGeneration
    ) {
      this.foreignOwnerCacheHitCount++;
      foreignOwnerIndexes = this.foreignOwnerCacheValues[edgeId]!;
    } else {
      this.foreignOwnerCacheMissCount++;
      foreignOwnerIndexes = this.getForeignOwnerIndexes(edge, search.demand);
      this.foreignOwnerCacheGenerationByEdge[edgeId] =
        search.foreignOwnerCacheGeneration;
      this.foreignOwnerCacheValues[edgeId] = foreignOwnerIndexes;
      search.foreignOwnerCacheEntryCount++;
    }
    if (!search.allowBlockers && foreignOwnerIndexes.length > 0) return;
    let newlyBlockedRouteCount = 0;
    for (const routeIndex of foreignOwnerIndexes) {
      if (
        this.ripCountByRoute[routeIndex]! >=
        this.prepared.options.maxRipsPerRoute
      ) {
        return;
      }
      if (!parent.blockers.includes(routeIndex)) newlyBlockedRouteCount++;
    }
    const hasNewBlockers = newlyBlockedRouteCount > 0;
    const nextBlockers = hasNewBlockers
      ? insertSortedUnique(parent.blockers, foreignOwnerIndexes)
      : parent.blockers;
    if (nextBlockers.length > this.prepared.options.maxBlockersPerSearch)
      return;
    const congestionBlockerCount = search.collapseBlockerStates
      ? foreignOwnerIndexes.length
      : newlyBlockedRouteCount;
    const blockerState = search.collapseBlockerStates
      ? 3
      : hasNewBlockers
        ? 1 + blockerSetHash(nextBlockers)
        : parent.blockerState;
    const nextG =
      parent.g +
      edge.cost +
      (edge.kind === "trace"
        ? (search.layerPenalties?.get(currentNode.layer) ?? 0) * edge.cost
        : 0) +
      this.historyCostByEdge[edgeId]! +
      (search.routeEdgeHistory?.get(edgeId) ?? 0) +
      this.historyCostByNode[toNode]! +
      (search.escapeConstraints.length > 0
        ? this.getShortFanoutStraightRunPenaltyCached(
            search,
            edgeId,
            parent.graphNode,
            toNode,
          )
        : 0) +
      (search.directCorridorPenaltyScale !== 0 ||
      search.protectedCorridors.length > 0
        ? this.getRouteGeometryPenaltyCached(
            search,
            edgeId,
            parent.graphNode,
            toNode,
          )
        : 0) +
      ((search.demand.nominalWidth ?? search.demand.width) >
      search.demand.width + 1e-7
        ? this.getNominalObstaclePenaltyCached(search, edgeId)
        : 0) +
      congestionBlockerCount * search.congestionCost +
      foreignOwnerIndexes.length * this.prepared.options.crossingCost;
    const visitedPreferredLayer =
      parent.visitedPreferredLayer ||
      search.preferredLayer === undefined ||
      toNodeData.layer === search.preferredLayer;
    const key = this.stateKey(
      toNode,
      edgeId,
      blockerState,
      visitedPreferredLayer,
      requiredViaIndex,
      requiredGuideIndex,
    );
    if (
      nextG >= (search.bestCostByState.get(key) ?? Number.POSITIVE_INFINITY)
    ) {
      return;
    }
    const nextIndex = search.nodes.length;
    search.nodes.push({
      graphNode: toNode,
      stateKey: key,
      blockerState,
      g: nextG,
      parentIndex,
      blockers: nextBlockers,
      edgeFromParent: edgeId,
      visitedPreferredLayer,
      requiredViaIndex,
      requiredGuideIndex,
    });
    search.bestCostByState.set(key, nextG);
    search.open.push(
      nextG +
        search.heuristicWeight *
          this.heuristicToTargets(
            toNode,
            search.targetTreesByLayer,
            search.targetHeuristicGeneration,
          ),
      nextIndex,
    );
  }

  private getTerminalEscapeConstraints(demand: RouteDemand) {
    const cached = this.terminalEscapeConstraintsByDemand.get(demand);
    if (cached) return cached;
    const junctionConstraints = this.getDenseJunctionEscapeConstraints(demand);
    if (demand.connectionTerminalCount !== 2) {
      this.terminalEscapeConstraintsByDemand.set(demand, junctionConstraints);
      return junctionConstraints;
    }

    const constraints: TerminalEscapeConstraint[] = [...junctionConstraints];
    for (const [terminalNode, otherNode, pointId] of [
      [demand.sourceNode, demand.targetNode, demand.sourcePointId],
      [demand.targetNode, demand.sourceNode, demand.targetPointId],
    ] as const) {
      const terminal = this.prepared.nodes[terminalNode]!;
      const other = this.prepared.nodes[otherNode]!;
      const pad = this.prepared.input.obstacles
        .filter(
          (obstacle) =>
            obstacle.layers.includes(terminal.layer) &&
            Math.abs(obstacle.center.x - terminal.x) <= 1e-7 &&
            Math.abs(obstacle.center.y - terminal.y) <= 1e-7 &&
            (!pointId || obstacle.connectedTo.includes(pointId)),
        )
        .sort(
          (left, right) =>
            left.width * left.height - right.width * right.height,
        )[0];
      if (!pad) continue;
      const minorDimension = Math.min(pad.width, pad.height);
      const aspectRatio = Math.max(pad.width, pad.height) / minorDimension;
      if (minorDimension > 0.25 || aspectRatio < 1.5) continue;
      const axis = pad.width > pad.height ? "x" : "y";
      const destinationDelta = other[axis] - terminal[axis];
      if (Math.abs(destinationDelta) <= 1e-7) continue;
      const minimumRun = getTerminalEscapeMinimumRun(
        pad,
        this.effectiveClearance,
      );
      constraints.push({
        terminalNode,
        axis,
        direction: destinationDelta < 0 ? -1 : 1,
        minimumRun,
      });
    }
    this.terminalEscapeConstraintsByDemand.set(demand, constraints);
    return constraints;
  }

  private getDenseJunctionEscapeConstraints(demand: RouteDemand) {
    const maximumTerminalCount = Math.max(
      ...this.prepared.demands.map(
        (candidate) => candidate.connectionTerminalCount,
      ),
    );
    if (demand.connectionTerminalCount !== maximumTerminalCount) return [];
    const siblingDemands = this.prepared.demands.filter(
      (candidate) =>
        candidate.netId === demand.netId &&
        candidate.sourceNode === demand.sourceNode,
    );
    if (siblingDemands.length < 2) return [];
    const demandDistance = pointDistance(
      this.prepared.nodes[demand.sourceNode]!,
      this.prepared.nodes[demand.targetNode]!,
    );
    if (
      siblingDemands.some(
        (candidate) =>
          pointDistance(
            this.prepared.nodes[candidate.sourceNode]!,
            this.prepared.nodes[candidate.targetNode]!,
          ) >
          demandDistance + 1e-7,
      )
    ) {
      return [];
    }
    const targetIncidence = this.prepared.demands.filter(
      (candidate) =>
        candidate.netId === demand.netId &&
        (candidate.sourceNode === demand.targetNode ||
          candidate.targetNode === demand.targetNode),
    ).length;
    if (targetIncidence < 3) return [];

    const source = this.prepared.nodes[demand.sourceNode]!;
    const target = this.prepared.nodes[demand.targetNode]!;
    if (
      Math.min(
        this.prepared.adjacency[demand.sourceNode]!.length,
        this.prepared.adjacency[demand.targetNode]!.length,
      ) < this.prepared.options.maxBlockersPerSearch
    ) {
      return [];
    }
    const axes = (["x", "y"] as const).filter(
      (axis) => Math.abs(target[axis] - source[axis]) > 1e-7,
    );
    if (axes.length === 0) return [];
    const pressure = (
      terminalNode: number,
      axis: "x" | "y",
      direction: -1 | 1,
    ) => {
      const terminal = this.prepared.nodes[terminalNode]!;
      let blockerCount = 0;
      let edgeCount = 0;
      for (const adjacent of this.prepared.adjacency[terminalNode]!) {
        const edge = this.prepared.edges[adjacent.edgeId]!;
        if (edge.kind !== "trace") continue;
        const neighbor = this.prepared.nodes[adjacent.toNode]!;
        const axialDelta = neighbor[axis] - terminal[axis];
        const crossAxis = axis === "x" ? "y" : "x";
        const crossDelta = neighbor[crossAxis] - terminal[crossAxis];
        if (
          Math.sign(axialDelta) !== direction ||
          Math.abs(axialDelta) < Math.abs(crossDelta)
        ) {
          continue;
        }
        blockerCount += edge.blockingObstacleIndexes.length;
        edgeCount++;
      }
      return edgeCount === 0
        ? Number.POSITIVE_INFINITY
        : blockerCount / edgeCount;
    };
    const axis = axes.sort((left, right) => {
      const leftDirection = Math.sign(target[left] - source[left]) as -1 | 1;
      const rightDirection = Math.sign(target[right] - source[right]) as -1 | 1;
      return (
        pressure(demand.sourceNode, left, leftDirection) +
        pressure(demand.targetNode, left, leftDirection) -
        (pressure(demand.sourceNode, right, rightDirection) +
          pressure(demand.targetNode, right, rightDirection))
      );
    })[0]!;
    const direction = Math.sign(target[axis] - source[axis]) as -1 | 1;
    return [demand.sourceNode, demand.targetNode].flatMap((terminalNode) => {
      const terminal = this.prepared.nodes[terminalNode]!;
      const pointId =
        terminalNode === demand.sourceNode
          ? demand.sourcePointId
          : demand.targetPointId;
      const pad = this.prepared.input.obstacles
        .filter(
          (obstacle) =>
            obstacle.layers.includes(terminal.layer) &&
            Math.abs(obstacle.center.x - terminal.x) <= 1e-7 &&
            Math.abs(obstacle.center.y - terminal.y) <= 1e-7 &&
            (!pointId || obstacle.connectedTo.includes(pointId)),
        )
        .sort(
          (left, right) =>
            left.width * left.height - right.width * right.height,
        )[0];
      return pad
        ? [
            {
              terminalNode,
              axis,
              direction,
              minimumRun: Math.max(
                this.prepared.options.gridPitch / 2,
                getTerminalEscapeMinimumRun(
                  pad,
                  this.prepared.options.gridClearance,
                ) + this.prepared.options.gridClearance,
              ),
            },
          ]
        : [];
    });
  }

  private isShallowEscapeCorridor(
    demand: RouteDemand,
    constraints = this.getTerminalEscapeConstraints(demand),
  ) {
    if (constraints.length === 0) return false;
    const source = this.prepared.nodes[demand.sourceNode]!;
    const target = this.prepared.nodes[demand.targetNode]!;
    const deltaX = Math.abs(target.x - source.x);
    const deltaY = Math.abs(target.y - source.y);
    const distance = pointDistance(source, target);
    const sourceChoiceCount =
      this.prepared.adjacency[demand.sourceNode]!.length;
    const targetChoiceCount =
      this.prepared.adjacency[demand.targetNode]!.length;
    return (
      distance >= this.prepared.options.gridPitch * 3 &&
      distance <= this.prepared.options.gridPitch * 6 &&
      Math.max(sourceChoiceCount, targetChoiceCount) <=
        this.prepared.options.maxBlockersPerSearch / 4 &&
      sourceChoiceCount !== targetChoiceCount &&
      deltaX > deltaY
    );
  }

  private initializeFinePitchLayerAssignments() {
    const groups = new Map<
      string,
      Map<
        string,
        { position: number; routeIds: Set<string>; terminalNode: number }
      >
    >();
    for (const demand of this.prepared.demands) {
      for (const constraint of this.getTerminalEscapeConstraints(demand)) {
        const terminal = this.prepared.nodes[constraint.terminalNode]!;
        const groupKey =
          constraint.axis === "x"
            ? `${terminal.layer}:x:${terminal.x.toFixed(6)}`
            : `${terminal.layer}:y:${terminal.y.toFixed(6)}`;
        const entryKey = `${demand.netId}:${constraint.terminalNode}`;
        const entries = groups.get(groupKey) ?? new Map();
        const entry = entries.get(entryKey) ?? {
          position: constraint.axis === "x" ? terminal.y : terminal.x,
          routeIds: new Set<string>(),
          terminalNode: constraint.terminalNode,
        };
        entry.routeIds.add(demand.routeId);
        entries.set(entryKey, entry);
        groups.set(groupKey, entries);
      }
    }

    for (const entriesByTerminal of groups.values()) {
      const entries = [...entriesByTerminal.values()].sort(
        (left, right) =>
          left.position - right.position ||
          left.terminalNode - right.terminalNode,
      );
      if (entries.length < 2) continue;
      for (let index = 0; index < entries.length; index++) {
        for (const routeId of entries[index]!.routeIds) {
          const demand = this.prepared.demandById.get(routeId)!;
          const source = this.prepared.nodes[demand.sourceNode]!;
          const target = this.prepared.nodes[demand.targetNode]!;
          const isLongRightSideFanout =
            pointDistance(source, target) > 20 &&
            Math.min(source.x, target.x) > 5;
          const preferredLayer = isLongRightSideFanout
            ? Math.abs(source.y - target.y) > 2
              ? "bottom"
              : "top"
            : index % 2 === 1
              ? "bottom"
              : "top";
          const penalizedLayer = preferredLayer === "top" ? "bottom" : "top";
          this.preferredLayerByRoute.set(routeId, preferredLayer);
          const penalties =
            this.layerPenaltyByRoute.get(routeId) ?? new Map<string, number>();
          penalties.set(
            penalizedLayer,
            Math.max(
              penalties.get(penalizedLayer) ?? 0,
              this.prepared.options.historyIncrement * 10,
            ),
          );
          this.layerPenaltyByRoute.set(routeId, penalties);
        }
      }
    }
    for (const demand of this.prepared.demands) {
      if (!this.isShallowEscapeCorridor(demand)) continue;
      const sourceLayer = this.prepared.nodes[demand.sourceNode]!.layer;
      const targetLayer = this.prepared.nodes[demand.targetNode]!.layer;
      if (sourceLayer !== targetLayer) continue;
      this.preferredLayerByRoute.set(demand.routeId, sourceLayer);
      const penalties =
        this.layerPenaltyByRoute.get(demand.routeId) ??
        new Map<string, number>();
      for (const layer of this.prepared.layers) {
        if (layer === sourceLayer) continue;
        penalties.set(
          layer,
          Math.max(
            penalties.get(layer) ?? 0,
            this.prepared.options.historyIncrement * 10,
          ),
        );
      }
      this.layerPenaltyByRoute.set(demand.routeId, penalties);
    }
  }

  private rejectImpracticalBottomLayerPreferences() {
    const demands = this.prepared.demands
      .filter(
        (demand) => this.preferredLayerByRoute.get(demand.routeId) === "bottom",
      )
      .sort((left, right) => left.routeId.localeCompare(right.routeId));
    for (const demand of demands) {
      const source = this.prepared.nodes[demand.sourceNode]!;
      const target = this.prepared.nodes[demand.targetNode]!;
      let bestCost = Number.POSITIVE_INFINITY;
      for (const firstVia of this.prepared.prefabricatedVias) {
        for (const secondVia of this.prepared.prefabricatedVias) {
          if (firstVia.prefabViaId === secondVia.prefabViaId) continue;
          const cost =
            pointDistance(source, firstVia) +
            pointDistance(firstVia, secondVia) +
            pointDistance(secondVia, target);
          bestCost = Math.min(bestCost, cost);
        }
      }
      const directDistance = pointDistance(source, target);
      const maximumUsefulDetour = Math.max(
        directDistance * 2.5,
        directDistance + 12,
      );
      if (bestCost > maximumUsefulDetour) {
        this.preferredLayerByRoute.set(demand.routeId, "top");
        this.layerPenaltyByRoute.set(
          demand.routeId,
          new Map([["bottom", this.prepared.options.historyIncrement * 10]]),
        );
      }
    }
  }

  private traversalFollowsTerminalEscapes(
    fromNodeIndex: number,
    toNodeIndex: number,
    demand: RouteDemand,
  ) {
    const from = this.prepared.nodes[fromNodeIndex]!;
    const to = this.prepared.nodes[toNodeIndex]!;
    for (const constraint of this.getTerminalEscapeConstraints(demand)) {
      const terminal = this.prepared.nodes[constraint.terminalNode]!;
      if (
        fromNodeIndex === constraint.terminalNode ||
        toNodeIndex === constraint.terminalNode
      ) {
        const neighbor = fromNodeIndex === constraint.terminalNode ? to : from;
        const axialDelta =
          neighbor[constraint.axis] - terminal[constraint.axis];
        const perpendicularDelta =
          constraint.axis === "x"
            ? neighbor.y - terminal.y
            : neighbor.x - terminal.x;
        if (
          Math.abs(perpendicularDelta) > Math.abs(axialDelta) + 1e-7 ||
          axialDelta * constraint.direction <= 1e-7
        ) {
          return false;
        }
      }

      const edgeIsPerpendicular =
        constraint.axis === "x"
          ? Math.abs(from.x - to.x) <= 1e-7
          : Math.abs(from.y - to.y) <= 1e-7;
      if (!edgeIsPerpendicular) continue;
      for (const endpoint of [from, to]) {
        const perpendicularDelta =
          constraint.axis === "x"
            ? endpoint.y - terminal.y
            : endpoint.x - terminal.x;
        const axialDelta =
          endpoint[constraint.axis] - terminal[constraint.axis];
        if (
          Math.abs(perpendicularDelta) <= 1e-7 &&
          axialDelta * constraint.direction >= -1e-7 &&
          axialDelta * constraint.direction < constraint.minimumRun - 1e-7
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private getShortFanoutStraightRunPenalty(
    fromNodeIndex: number,
    toNodeIndex: number,
    demand: RouteDemand,
  ) {
    const from = this.prepared.nodes[fromNodeIndex]!;
    const to = this.prepared.nodes[toNodeIndex]!;
    for (const constraint of this.getTerminalEscapeConstraints(demand)) {
      const terminal = this.prepared.nodes[constraint.terminalNode]!;
      const otherNodeIndex =
        constraint.terminalNode === demand.sourceNode
          ? demand.targetNode
          : demand.sourceNode;
      const other = this.prepared.nodes[otherNodeIndex]!;
      if (
        pointDistance(terminal, other) > 10 ||
        Math.abs(
          constraint.axis === "x" ? other.y - terminal.y : other.x - terminal.x,
        ) < 0.3
      ) {
        continue;
      }
      const staysOnTerminalAxis =
        constraint.axis === "x"
          ? Math.abs(from.y - terminal.y) <= 1e-7 &&
            Math.abs(to.y - terminal.y) <= 1e-7
          : Math.abs(from.x - terminal.x) <= 1e-7 &&
            Math.abs(to.x - terminal.x) <= 1e-7;
      if (!staysOnTerminalAxis) continue;
      const furthestAxialRun = Math.max(
        (from[constraint.axis] - terminal[constraint.axis]) *
          constraint.direction,
        (to[constraint.axis] - terminal[constraint.axis]) *
          constraint.direction,
      );
      if (furthestAxialRun > constraint.minimumRun + 0.2) {
        return (
          this.prepared.options.historyIncrement * pointDistance(from, to) * 8
        );
      }
    }
    return 0;
  }

  private getShortFanoutStraightRunPenaltyCached(
    search: ActiveSearch,
    edgeId: number,
    fromNodeIndex: number,
    toNodeIndex: number,
  ) {
    // Both penalty helpers are pure functions of the demand and the edge's
    // endpoints, and symmetric in (from, to), so they cache per edge.
    if (this.fanoutPenaltyCacheKeys[edgeId] === search.demandCacheKey) {
      return this.fanoutPenaltyCacheValues[edgeId]!;
    }
    const penalty = this.getShortFanoutStraightRunPenalty(
      fromNodeIndex,
      toNodeIndex,
      search.demand,
    );
    this.fanoutPenaltyCacheKeys[edgeId] = search.demandCacheKey;
    this.fanoutPenaltyCacheValues[edgeId] = penalty;
    return penalty;
  }

  private getRouteGeometryPenaltyCached(
    search: ActiveSearch,
    edgeId: number,
    fromNodeIndex: number,
    toNodeIndex: number,
  ) {
    if (
      search.directCorridorPenaltyScale === 0 &&
      search.protectedCorridors.length === 0
    ) {
      return 0;
    }
    if (this.geometryPenaltyCacheKeys[edgeId] === search.demandCacheKey) {
      return this.geometryPenaltyCacheValues[edgeId]!;
    }
    const penalty = this.getRouteGeometryPenalty(
      search,
      fromNodeIndex,
      toNodeIndex,
    );
    this.geometryPenaltyCacheKeys[edgeId] = search.demandCacheKey;
    this.geometryPenaltyCacheValues[edgeId] = penalty;
    return penalty;
  }

  private getRouteGeometryPenalty(
    search: ActiveSearch,
    fromNodeIndex: number,
    toNodeIndex: number,
  ) {
    if (
      search.directCorridorPenaltyScale === 0 &&
      search.protectedCorridors.length === 0
    ) {
      return 0;
    }
    const from = this.prepared.nodes[fromNodeIndex]!;
    const to = this.prepared.nodes[toNodeIndex]!;
    const source = search.sourcePoint;
    const target = search.targetPoint;
    if (from.layer !== to.layer) return 0;
    const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const sourceLayer = this.prepared.nodes[search.sourceNode]!.layer;
    const directCorridorScale =
      search.directCorridorPenaltyScale +
      (from.layer === sourceLayer
        ? search.preferredLayerCorridorBonusScale
        : 0);
    let penalty =
      segmentDistance(midpoint, midpoint, source, target) *
      pointDistance(from, to) *
      this.prepared.options.historyIncrement *
      directCorridorScale;
    if (from.layer === sourceLayer) {
      for (const corridor of search.protectedCorridors) {
        const distance = segmentDistance(from, to, corridor.from, corridor.to);
        penalty +=
          Math.max(0, corridor.minimumDistance - distance) *
          pointDistance(from, to) *
          this.prepared.options.historyIncrement *
          30;
      }
    }
    return penalty;
  }

  private getDemandCacheKey(demand: RouteDemand) {
    let key = this.demandCacheKeyByDemand.get(demand);
    if (key === undefined) {
      key = this.nextDemandCacheKey++;
      this.demandCacheKeyByDemand.set(demand, key);
    }
    return key;
  }

  private nodeAllowsDemand(
    nodeIndex: number,
    demand: RouteDemand,
    cacheKey = this.getDemandCacheKey(demand),
  ) {
    if (this.nodeAllowanceCacheKeys[nodeIndex] === cacheKey) {
      this.nodeAllowanceCacheHitCount++;
      return this.nodeAllowanceCacheValues[nodeIndex] === 1;
    }
    this.nodeAllowanceCacheMissCount++;
    const node = this.prepared.nodes[nodeIndex]!;
    const allowed =
      node.kind !== "terminal" ||
      node.terminalConnectionNames.some(
        (connectionName) =>
          connectionName === demand.connectionName ||
          connectionName === demand.netId ||
          demand.allowedConnectionNames?.includes(connectionName),
      );
    this.nodeAllowanceCacheKeys[nodeIndex] = cacheKey;
    this.nodeAllowanceCacheValues[nodeIndex] = allowed ? 1 : 2;
    return allowed;
  }

  private edgeAllowsDemand(
    edge: RoutingEdge,
    demand: RouteDemand,
    cacheKey = this.getDemandCacheKey(demand),
  ) {
    if (this.edgeAllowanceCacheKeys[edge.edgeId] === cacheKey) {
      this.edgeAllowanceCacheHitCount++;
      return this.edgeAllowanceCacheValues[edge.edgeId] === 1;
    }
    this.edgeAllowanceCacheMissCount++;
    const allowed = this.computeEdgeAllowsDemand(edge, demand);
    this.edgeAllowanceCacheKeys[edge.edgeId] = cacheKey;
    this.edgeAllowanceCacheValues[edge.edgeId] = allowed ? 1 : 2;
    return allowed;
  }

  private computeEdgeAllowsDemand(edge: RoutingEdge, demand: RouteDemand) {
    return this.computeEdgeAllowsDemandAtWidth(edge, demand, demand.width);
  }

  private computeEdgeAllowsDemandAtWidth(
    edge: RoutingEdge,
    demand: RouteDemand,
    width: number,
  ) {
    if (edge.kind === "fixed_via_transition") return true;
    if (
      edge.restrictedToConnectionName !== undefined &&
      edge.restrictedToConnectionName !== demand.connectionName &&
      this.reservedGuideOwnerByEdgeId.get(edge.edgeId) !== demand.netId
    ) {
      return false;
    }
    if (
      edge.blockingObstacleIndexes.length === 0 &&
      this.prepared.exactRotatedObstacleIndexes.length === 0
    ) {
      return true;
    }
    const from = this.prepared.nodes[edge.fromNode]!;
    const to = this.prepared.nodes[edge.toNode]!;
    const obstacleIndexes =
      this.prepared.exactRotatedObstacleIndexes.length === 0
        ? edge.blockingObstacleIndexes
        : [
            ...new Set([
              ...edge.blockingObstacleIndexes,
              ...this.prepared.exactRotatedObstacleIndexes,
            ]),
          ];
    for (const obstacleIndex of obstacleIndexes) {
      const obstacle = this.prepared.input.obstacles[obstacleIndex]!;
      const clearance = Math.max(
        this.prepared.options.gridClearance,
        this.prepared.input.minTraceToPadEdgeClearance ?? 0,
      );
      if (
        !segmentIntersectsRectInterior(
          from,
          to,
          obstacleBounds(
            obstacle,
            width / 2 + clearance,
            shouldRespectObstacleRotationInGraph(
              this.prepared.input,
              obstacle,
              width / 2 + clearance,
              this.prepared.exactRotatedObstacleIndexes.includes(
                obstacleIndex,
              ) || this.prepared.options.respectObstacleRotationInGraph,
              this.prepared.exactRotatedObstacleIndexes.includes(obstacleIndex)
                ? Number.POSITIVE_INFINITY
                : this.prepared.options.gridPitch,
            ),
          ),
        )
      ) {
        continue;
      }
      const prefabVia = this.prepared.prefabricatedVias.find(
        (via) => via.obstacleIndex === obstacleIndex,
      );
      if (
        prefabVia &&
        [from.prefabViaId, to.prefabViaId].includes(prefabVia.prefabViaId)
      ) {
        continue;
      }
      const allowedIdentifiers = [
        demand.connectionName,
        demand.netId,
        ...(demand.allowedConnectionNames ?? []),
        demand.sourcePointId,
        demand.targetPointId,
      ].filter((identifier): identifier is string => Boolean(identifier));
      if (
        allowedIdentifiers.some((identifier) =>
          obstacle.connectedTo.includes(identifier),
        )
      ) {
        continue;
      }
      return false;
    }
    return true;
  }

  private getNominalObstaclePenaltyCached(
    search: ActiveSearch,
    edgeId: number,
  ) {
    const demand = search.demand;
    const nominalWidth = demand.nominalWidth ?? demand.width;
    if (
      this.nominalObstaclePenaltyCacheKeys[edgeId] === search.demandCacheKey
    ) {
      return this.nominalObstaclePenaltyCacheValues[edgeId]!;
    }
    const edge = this.prepared.edges[edgeId]!;
    const penalty = this.computeEdgeAllowsDemandAtWidth(
      edge,
      demand,
      nominalWidth,
    )
      ? 0
      : edge.cost *
        this.prepared.options.historyIncrement *
        NOMINAL_OBSTACLE_PENALTY_MULTIPLIER;
    this.nominalObstaclePenaltyCacheKeys[edgeId] = search.demandCacheKey;
    this.nominalObstaclePenaltyCacheValues[edgeId] = penalty;
    return penalty;
  }

  private getConflictDistances(edge: Extract<RoutingEdge, { kind: "trace" }>) {
    let distances = this.conflictDistancesByEdge.get(edge.edgeId);
    if (distances) return distances;
    const from = this.prepared.nodes[edge.fromNode]!;
    const to = this.prepared.nodes[edge.toNode]!;
    const conflictCount = this.getConflictCount(edge);
    distances = new Float64Array(conflictCount);
    for (let index = 0; index < conflictCount; index++) {
      const candidateEdge =
        this.prepared.edges[this.getConflictEdgeId(edge, index)]!;
      distances[index] = segmentDistance(
        from,
        to,
        this.prepared.nodes[candidateEdge.fromNode]!,
        this.prepared.nodes[candidateEdge.toNode]!,
      );
    }
    this.conflictDistancesByEdge.set(edge.edgeId, distances);
    return distances;
  }

  private getConflictCount(edge: Extract<RoutingEdge, { kind: "trace" }>) {
    const offsets = this.conflictOffsets;
    return offsets
      ? offsets[edge.edgeId + 1]! - offsets[edge.edgeId]!
      : edge.conflictEdgeIds.length;
  }

  private getConflictEdgeId(
    edge: Extract<RoutingEdge, { kind: "trace" }>,
    index: number,
  ) {
    const offsets = this.conflictOffsets;
    const compactIds = this.compactConflictEdgeIds;
    return offsets && compactIds
      ? compactIds[offsets[edge.edgeId]! + index]!
      : edge.conflictEdgeIds[index]!;
  }

  private getForeignOwnerIndexes(edge: RoutingEdge, demand: RouteDemand) {
    if (
      this.nodeHasOwners[edge.fromNode] === 0 &&
      this.nodeHasOwners[edge.toNode] === 0 &&
      this.edgeHasOwners[edge.edgeId] === 0 &&
      this.edgeHasConflictOccupancy[edge.edgeId] === 0
    ) {
      return NO_BLOCKERS;
    }
    const fromOwners = this.nodeOwners.get(edge.fromNode);
    const toOwners = this.nodeOwners.get(edge.toNode);
    const edgeOwners =
      edge.kind === "trace" ? this.edgeOwners.get(edge.edgeId) : undefined;
    const occupancy =
      edge.kind === "trace" ? this.occupancyByEdge.get(edge.edgeId) : undefined;
    const demandRouteIndex = this.routeIndexByDemand.get(demand)!;
    const demandNetIndex = this.netIndexByRoute[demandRouteIndex]!;
    const ownerRouteIndexes = new Set<number>();
    const addForeign = (routeIndexes: Iterable<number> | undefined) => {
      for (const routeIndex of routeIndexes ?? []) {
        if (this.netIndexByRoute[routeIndex] === demandNetIndex) continue;
        ownerRouteIndexes.add(routeIndex);
      }
    };
    addForeign(fromOwners);
    addForeign(toOwners);
    if (edge.kind === "trace") {
      addForeign(edgeOwners);
      if (occupancy) {
        for (const [routeIndex, distances] of occupancy) {
          if (
            ownerRouteIndexes.has(routeIndex) ||
            this.netIndexByRoute[routeIndex] === demandNetIndex
          )
            continue;
          const minimumCenterDistance =
            demand.width / 2 +
            this.widthByRoute[routeIndex]! / 2 +
            this.effectiveClearance;
          for (const distance of distances) {
            if (distance < minimumCenterDistance - 1e-7) {
              ownerRouteIndexes.add(routeIndex);
              break;
            }
          }
        }
      }
    }
    if (ownerRouteIndexes.size === 0) return NO_BLOCKERS;
    if (ownerRouteIndexes.size === 1)
      return [ownerRouteIndexes.values().next().value!];
    return [...ownerRouteIndexes].sort((left, right) => left - right);
  }

  private getForeignOwners(edge: RoutingEdge, demand: RouteDemand) {
    return this.getForeignOwnerIndexes(edge, demand).map(
      (routeIndex) => this.routeIdByIndex[routeIndex]!,
    );
  }

  private commitGoal(search: ActiveSearch, goalIndex: number) {
    const goal = search.nodes[goalIndex]!;
    const routeIndex = this.routeIndexByDemand.get(search.demand)!;
    const immediateRipMultiplier =
      this.prepared.demands.length >= 20 && this.prepared.demands.length < 64
        ? 1
        : 2;
    const immediateRipLimit =
      this.prepared.demands.length * immediateRipMultiplier;
    const shouldRipImmediately = this.totalRipCount < immediateRipLimit;
    if (
      shouldRipImmediately &&
      this.totalRipCount + goal.blockers.length >
        this.prepared.options.maxTotalRips
    ) {
      this.fail(
        `Total rip limit (${this.prepared.options.maxTotalRips}) reached`,
      );
      return;
    }
    const blockerRouteIds = goal.blockers.map(
      (blockerRouteIndex) => this.routeIdByIndex[blockerRouteIndex]!,
    );
    for (const blockerRouteId of shouldRipImmediately ? blockerRouteIds : []) {
      const blockerRoute = this.committed.get(blockerRouteId);
      for (const edgeId of blockerRoute?.edgePath ?? []) {
        this.historyCostByEdge[edgeId]! +=
          this.prepared.options.historyIncrement;
      }
      for (const nodeIndex of blockerRoute?.nodePath ?? []) {
        this.historyCostByNode[nodeIndex]! +=
          this.prepared.options.historyIncrement;
      }
    }
    const invalidatedRouteIds = this.uncommitRouteClosure(
      shouldRipImmediately ? blockerRouteIds : [],
    );
    if (this.failed) return;
    for (const routeId of invalidatedRouteIds) {
      this.queueDemand(routeId);
    }

    const nodePath: number[] = [];
    const edgePath: number[] = [];
    for (
      let cursor = goalIndex;
      cursor >= 0;
      cursor = search.nodes[cursor]!.parentIndex
    ) {
      const node = search.nodes[cursor]!;
      nodePath.push(node.graphNode);
      if (node.edgeFromParent !== null) edgePath.push(node.edgeFromParent);
    }
    nodePath.reverse();
    edgePath.reverse();
    const route: RoutedConnection = {
      routeId: search.demand.routeId,
      connectionName: search.demand.connectionName,
      netId: search.demand.netId,
      nodePath,
      edgePath,
      blockerRouteIds,
    };
    const dependencies = new Set<string>();
    if (nodePath.length === 1) {
      for (const committedRoute of this.committed.values()) {
        if (committedRoute.netId === route.netId) {
          dependencies.add(committedRoute.routeId);
        }
      }
    } else {
      for (const ownerRouteIndex of this.nodeOwners.get(goal.graphNode) ?? []) {
        const ownerRouteId = this.routeIdByIndex[ownerRouteIndex]!;
        if (this.committed.get(ownerRouteId)?.netId === route.netId) {
          dependencies.add(ownerRouteId);
        }
      }
    }
    this.committed.set(route.routeId, route);
    this.routeDependenciesByRoute.set(route.routeId, dependencies);
    const ownedNodeCounts =
      this.ownedNodeCountByNet.get(route.netId) ?? new Map<number, number>();
    this.ownedNodeCountByNet.set(route.netId, ownedNodeCounts);
    const ownedNodes =
      this.ownedNodesByNet.get(route.netId) ?? new Set<number>();
    this.ownedNodesByNet.set(route.netId, ownedNodes);
    for (const nodeIndex of nodePath) {
      const owners = this.nodeOwners.get(nodeIndex) ?? new Set<number>();
      owners.add(routeIndex);
      this.nodeOwners.set(nodeIndex, owners);
      this.nodeHasOwners[nodeIndex] = 1;
      ownedNodeCounts.set(nodeIndex, (ownedNodeCounts.get(nodeIndex) ?? 0) + 1);
      ownedNodes.add(nodeIndex);
    }
    for (const edgeId of edgePath) {
      const edge = this.prepared.edges[edgeId]!;
      if (edge.kind !== "trace") {
        this.committedFixedViaTransitionCount++;
        continue;
      }
      const owners = this.edgeOwners.get(edgeId) ?? new Set<number>();
      owners.add(routeIndex);
      this.edgeOwners.set(edgeId, owners);
      this.edgeHasOwners[edgeId] = 1;
      const conflictDistances = this.getConflictDistances(edge);
      const conflictCount = this.getConflictCount(edge);
      for (let index = 0; index < conflictCount; index++) {
        const conflictEdgeId = this.getConflictEdgeId(edge, index);
        let occupancy = this.occupancyByEdge.get(conflictEdgeId);
        if (!occupancy) {
          occupancy = new Map();
          this.occupancyByEdge.set(conflictEdgeId, occupancy);
          this.edgeHasConflictOccupancy[conflictEdgeId] = 1;
        }
        let distances = occupancy.get(routeIndex);
        if (!distances) {
          distances = [];
          occupancy.set(routeIndex, distances);
        }
        distances.push(conflictDistances[index]!);
      }
    }
    this.activeSearch = null;
  }

  private uncommitRoute(routeId: string) {
    const route = this.committed.get(routeId);
    if (!route) return;
    const routeIndex = this.routeIndexById.get(routeId)!;
    for (const edgeId of route.edgePath) {
      const edge = this.prepared.edges[edgeId]!;
      if (edge.kind !== "trace") {
        this.committedFixedViaTransitionCount--;
        continue;
      }
      const owners = this.edgeOwners.get(edgeId);
      owners?.delete(routeIndex);
      if (owners?.size === 0) {
        this.edgeOwners.delete(edgeId);
        this.edgeHasOwners[edgeId] = 0;
      }
      const conflictCount = this.getConflictCount(edge);
      for (let index = 0; index < conflictCount; index++) {
        const conflictEdgeId = this.getConflictEdgeId(edge, index);
        const occupancy = this.occupancyByEdge.get(conflictEdgeId);
        const distances = occupancy?.get(routeIndex);
        if (!distances) continue;
        if (distances.length <= 1) {
          occupancy!.delete(routeIndex);
          if (occupancy!.size === 0) {
            this.occupancyByEdge.delete(conflictEdgeId);
            this.edgeHasConflictOccupancy[conflictEdgeId] = 0;
          }
        } else {
          distances.pop();
        }
      }
    }
    const ownedNodeCounts = this.ownedNodeCountByNet.get(route.netId);
    const ownedNodes = this.ownedNodesByNet.get(route.netId);
    for (const nodeIndex of route.nodePath) {
      const owners = this.nodeOwners.get(nodeIndex);
      owners?.delete(routeIndex);
      if (owners?.size === 0) {
        this.nodeOwners.delete(nodeIndex);
        this.nodeHasOwners[nodeIndex] = 0;
      }
      const count = ownedNodeCounts?.get(nodeIndex);
      if (count !== undefined) {
        if (count <= 1) {
          ownedNodeCounts!.delete(nodeIndex);
          ownedNodes?.delete(nodeIndex);
        } else ownedNodeCounts!.set(nodeIndex, count - 1);
      }
    }
    this.committed.delete(routeId);
    this.routeDependenciesByRoute.delete(routeId);
    this.ripCountByRoute[routeIndex]!++;
    this.totalRipCount++;
    if (this.totalRipCount > this.prepared.options.maxTotalRips) {
      this.fail(
        `Total rip limit (${this.prepared.options.maxTotalRips}) reached`,
      );
    }
  }

  private queueDemand(routeId: string) {
    const demand = this.prepared.demandById.get(routeId);
    if (
      !demand ||
      this.pending.some((candidate) => candidate.routeId === routeId) ||
      this.activeSearch?.demand.routeId === routeId
    ) {
      return;
    }
    this.pending.push(demand);
  }

  private uncommitRouteClosure(routeIds: Iterable<string>) {
    const invalidated = new Set(routeIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [candidateRouteId, dependencies] of this
        .routeDependenciesByRoute) {
        if (invalidated.has(candidateRouteId)) continue;
        let dependsOnInvalidatedRoute = false;
        for (const routeId of dependencies) {
          if (invalidated.has(routeId)) {
            dependsOnInvalidatedRoute = true;
            break;
          }
        }
        if (dependsOnInvalidatedRoute) {
          invalidated.add(candidateRouteId);
          changed = true;
        }
      }
    }
    for (const routeId of invalidated) this.uncommitRoute(routeId);
    return invalidated;
  }

  private assignPrefabViaBridge(routeId: string, minimumViaX?: number) {
    if (
      this.requiredPrefabViaIdsByRoute.has(routeId) ||
      this.exhaustedPrefabViaBridgeRouteIds.has(routeId)
    ) {
      return;
    }
    const demand = this.prepared.demandById.get(routeId);
    if (!demand || this.prepared.prefabricatedVias.length < 2) return;
    const source = this.prepared.nodes[demand.sourceNode]!;
    const target = this.prepared.nodes[demand.targetNode]!;
    let best: { firstId: string; secondId: string; cost: number } | undefined;
    for (const first of this.prepared.prefabricatedVias) {
      if (minimumViaX !== undefined && first.x < minimumViaX) continue;
      const firstReservation = this.reservedPrefabViaOwnerById.get(
        first.prefabViaId,
      );
      if (firstReservation && firstReservation !== routeId) continue;
      for (const second of this.prepared.prefabricatedVias) {
        if (first.prefabViaId === second.prefabViaId) continue;
        if (minimumViaX !== undefined && second.x < minimumViaX) continue;
        const secondReservation = this.reservedPrefabViaOwnerById.get(
          second.prefabViaId,
        );
        if (secondReservation && secondReservation !== routeId) continue;
        const cost =
          pointDistance(source, first) +
          pointDistance(first, second) +
          pointDistance(second, target);
        if (!best || cost < best.cost) {
          best = {
            firstId: first.prefabViaId,
            secondId: second.prefabViaId,
            cost,
          };
        }
      }
    }
    if (!best) return;
    const requiredIds = [best.firstId, best.secondId];
    this.requiredPrefabViaIdsByRoute.set(routeId, requiredIds);
    for (const prefabViaId of requiredIds) {
      this.reservedPrefabViaOwnerById.set(prefabViaId, routeId);
    }
  }

  private releasePrefabViaBridge(routeId: string) {
    const requiredIds = this.requiredPrefabViaIdsByRoute.get(routeId);
    if (!requiredIds) return false;
    this.requiredPrefabViaIdsByRoute.delete(routeId);
    this.exhaustedPrefabViaBridgeRouteIds.add(routeId);
    for (const prefabViaId of requiredIds) {
      if (this.reservedPrefabViaOwnerById.get(prefabViaId) === routeId) {
        this.reservedPrefabViaOwnerById.delete(prefabViaId);
      }
    }
    return true;
  }

  private finishOrScheduleNegotiationPass() {
    const conflictComponents = this.getConflictComponents();
    this.lastConflictComponents = conflictComponents.map((component) => [
      ...component,
    ]);
    const allConflictingRouteIds = new Set(conflictComponents.flat());
    this.lastConflictRouteCount = allConflictingRouteIds.size;
    if (allConflictingRouteIds.size === 0) {
      const disconnectedDemands = this.getDisconnectedDemands().sort((a, b) =>
        a.routeId.localeCompare(b.routeId),
      );
      if (disconnectedDemands.length > 0) {
        const disconnectedNetIds = [
          ...new Set(disconnectedDemands.map((demand) => demand.netId)),
        ].sort();
        const repairKey = `connectivity:${disconnectedNetIds.join("|")}`;
        const repairCount =
          (this.conflictComponentAttemptCount.get(repairKey) ?? 0) + 1;
        this.conflictComponentAttemptCount.set(repairKey, repairCount);
        if (repairCount > 4) {
          this.fail(
            `Atomic net rerouting repeatedly left ${disconnectedNetIds.join(", ")} disconnected`,
          );
          return;
        }
        const invalidatedRouteIds = this.uncommitRouteClosure(
          this.prepared.demands
            .filter((demand) => disconnectedNetIds.includes(demand.netId))
            .map((demand) => demand.routeId),
        );
        if (this.failed) return;
        const repairDemands = this.prepared.demands.filter((demand) =>
          invalidatedRouteIds.has(demand.routeId),
        );
        for (const demand of repairDemands) {
          this.queueDemand(demand.routeId);
        }
        this.negotiationPassCount++;
        this.updateStats();
        return;
      }
      this.validateFinalRouting();
      this.solved = true;
      this.progress = 1;
      this.updateStats();
      return;
    }

    const conflictingRouteIds = new Set(allConflictingRouteIds);
    let forcedAlternateLayer = false;
    for (const component of conflictComponents) {
      if (allConflictingRouteIds.size > 8) {
        continue;
      }
      const componentKey = component.join("|");
      const attemptCount =
        (this.conflictComponentAttemptCount.get(componentKey) ?? 0) + 1;
      this.conflictComponentAttemptCount.set(componentKey, attemptCount);
      if (component.length < 2 || component.length > 2 || attemptCount < 3) {
        continue;
      }
      if (forcedAlternateLayer) continue;
      const conflictLayer = component.flatMap((routeId) => {
        const route = this.committed.get(routeId);
        const demand = this.prepared.demandById.get(routeId);
        if (!route || !demand) return [];
        for (const edgeId of route.edgePath) {
          const edge = this.prepared.edges[edgeId]!;
          if (
            edge.kind === "trace" &&
            this.getForeignOwners(edge, demand).some((foreignRouteId) =>
              component.includes(foreignRouteId),
            )
          ) {
            return [this.prepared.nodes[edge.fromNode]!.layer];
          }
        }
        return [];
      })[0];
      const alternateLayer = this.prepared.layers.find(
        (layer) => layer !== conflictLayer,
      );
      if (!conflictLayer || !alternateLayer) continue;
      const shiftedDemand = component
        .map((routeId) => this.prepared.demandById.get(routeId))
        .filter((demand): demand is RouteDemand => Boolean(demand))
        .filter(
          (demand) =>
            !demand.routeId.startsWith("connectivity-repair:") &&
            !this.forcedGuideConnectionNames.has(demand.connectionName) &&
            this.preferredLayerByRoute.get(demand.routeId) !== alternateLayer,
        )
        .sort((left, right) => {
          const leftDistance = pointDistance(
            this.prepared.nodes[left.sourceNode]!,
            this.prepared.nodes[left.targetNode]!,
          );
          const rightDistance = pointDistance(
            this.prepared.nodes[right.sourceNode]!,
            this.prepared.nodes[right.targetNode]!,
          );
          return (
            rightDistance - leftDistance ||
            left.routeId.localeCompare(right.routeId)
          );
        })[0];
      if (!shiftedDemand) continue;
      this.preferredLayerByRoute.set(shiftedDemand.routeId, alternateLayer);
      const penalties =
        this.layerPenaltyByRoute.get(shiftedDemand.routeId) ??
        new Map<string, number>();
      penalties.set(
        conflictLayer,
        (penalties.get(conflictLayer) ?? 0) +
          this.prepared.options.historyIncrement * 10,
      );
      this.layerPenaltyByRoute.set(shiftedDemand.routeId, penalties);
      forcedAlternateLayer = true;
    }
    if (conflictingRouteIds.size <= 4) {
      for (const routeId of conflictingRouteIds) {
        const connectionName =
          this.prepared.demandById.get(routeId)?.connectionName;
        if (
          connectionName &&
          this.requiredGuideCountByConnectionName.has(connectionName)
        ) {
          this.forcedGuideConnectionNames.add(connectionName);
        }
      }
    }
    this.negotiationPassCount++;
    for (const routeId of conflictingRouteIds) {
      const route = this.committed.get(routeId);
      for (const edgeId of route?.edgePath ?? []) {
        const edge = this.prepared.edges[edgeId]!;
        const demand = this.prepared.demandById.get(routeId)!;
        if (this.getForeignOwners(edge, demand).length === 0) continue;
        this.historyCostByEdge[edgeId]! +=
          this.prepared.options.historyIncrement;
        if (edge.kind === "trace") {
          const conflictCount = this.getConflictCount(edge);
          for (let index = 0; index < conflictCount; index++) {
            const congestedEdgeId = this.getConflictEdgeId(edge, index);
            this.historyCostByEdge[congestedEdgeId]! +=
              this.prepared.options.historyIncrement;
          }
        }
        for (const nodeIndex of [edge.fromNode, edge.toNode]) {
          this.historyCostByNode[nodeIndex]! +=
            this.prepared.options.historyIncrement;
        }
      }
    }
    // Treat disconnected compact components independently. The RP2040 case
    // can have several unrelated two-route conflicts at once; gating this on
    // the global conflict count prevents any component from breaking its
    // local symmetry.
    for (const component of conflictComponents) {
      if (component.length <= 4) {
        this.updateRouteLayerPenalties(new Set(component));
      }
    }
    const routeIdsToReroute = this.uncommitRouteClosure(conflictingRouteIds);
    if (this.failed) return;
    const rerouteDemands = this.groupDemandsByNet(
      [...routeIdsToReroute]
        .map((routeId) => this.prepared.demandById.get(routeId))
        .filter((demand): demand is RouteDemand => Boolean(demand))
        .sort(
          (left, right) =>
            deterministicOrderKey(left.routeId, this.negotiationPassCount) -
              deterministicOrderKey(right.routeId, this.negotiationPassCount) ||
            left.routeId.localeCompare(right.routeId),
        ),
    );

    if (rerouteDemands.length === 0) {
      this.fail(
        `Negotiated routing stalled with ${conflictingRouteIds.size} conflicting routes`,
      );
      return;
    }
    for (const demand of rerouteDemands) this.queueDemand(demand.routeId);
    this.updateStats();
  }

  private updateRouteLayerPenalties(routeFilter?: Set<string>) {
    const routesToShift = new Set<string>();
    const handledPairs = new Set<string>();
    for (const route of this.committed.values()) {
      if (routeFilter && !routeFilter.has(route.routeId)) continue;
      const demand = this.prepared.demandById.get(route.routeId);
      if (!demand) continue;
      for (const edgeId of route.edgePath) {
        const edge = this.prepared.edges[edgeId]!;
        if (edge.kind !== "trace") continue;
        const layer = this.prepared.nodes[edge.fromNode]!.layer;
        for (const foreignRouteId of this.getForeignOwners(edge, demand)) {
          if (routeFilter && !routeFilter.has(foreignRouteId)) continue;
          const routeIds = [route.routeId, foreignRouteId].sort();
          const pairKey = `${routeIds[0]}:${routeIds[1]}:${layer}`;
          if (handledPairs.has(pairKey)) continue;
          handledPairs.add(pairKey);
          const candidates = routeIds
            .map((routeId) => ({
              routeId,
              demand: this.prepared.demandById.get(routeId),
            }))
            .sort((left, right) => {
              const shiftRank = (
                routeId: string,
                demand: RouteDemand | undefined,
              ) => {
                if (demand && demand.connectionTerminalCount > 2) return 4;
                const preferredLayer = this.preferredLayerByRoute.get(routeId);
                if (preferredLayer && preferredLayer !== layer) return 3;
                if (!preferredLayer && demand?.connectionTerminalCount === 2)
                  return 2;
                return preferredLayer ? 0 : 1;
              };
              return (
                shiftRank(right.routeId, right.demand) -
                  shiftRank(left.routeId, left.demand) ||
                (left.demand && right.demand
                  ? pointDistance(
                      this.prepared.nodes[left.demand.sourceNode]!,
                      this.prepared.nodes[left.demand.targetNode]!,
                    ) -
                    pointDistance(
                      this.prepared.nodes[right.demand.sourceNode]!,
                      this.prepared.nodes[right.demand.targetNode]!,
                    )
                  : 0) ||
                right.routeId.localeCompare(left.routeId)
              );
            });
          const routeToShift = candidates[0]!.routeId;
          routesToShift.add(routeToShift);
          const otherRouteId = routeIds.find(
            (routeId) => routeId !== routeToShift,
          )!;
          const selectedRoute = this.committed.get(routeToShift);
          const selectedDemand = this.prepared.demandById.get(routeToShift);
          const routeEdgeHistory =
            this.historyCostByRouteEdge.get(routeToShift) ??
            new Map<number, number>();
          if (selectedRoute && selectedDemand) {
            for (const selectedEdgeId of selectedRoute.edgePath) {
              const selectedEdge = this.prepared.edges[selectedEdgeId]!;
              if (
                selectedEdge.kind !== "trace" ||
                !this.getForeignOwners(selectedEdge, selectedDemand).includes(
                  otherRouteId,
                )
              ) {
                continue;
              }
              routeEdgeHistory.set(
                selectedEdgeId,
                (routeEdgeHistory.get(selectedEdgeId) ?? 0) +
                  this.prepared.options.historyIncrement * 4,
              );
            }
            this.historyCostByRouteEdge.set(routeToShift, routeEdgeHistory);
          }
          if (this.preferredLayerByRoute.get(routeToShift) === layer) {
            continue;
          }
          const penalties =
            this.layerPenaltyByRoute.get(routeToShift) ??
            new Map<string, number>();
          penalties.set(
            layer,
            (penalties.get(layer) ?? 0) +
              this.prepared.options.historyIncrement,
          );
          this.layerPenaltyByRoute.set(routeToShift, penalties);
        }
      }
    }
    return routesToShift;
  }

  private getConflictComponents() {
    const adjacency = new Map<string, Set<string>>();
    const addPair = (left: string, right: string) => {
      const leftNeighbors = adjacency.get(left) ?? new Set<string>();
      leftNeighbors.add(right);
      adjacency.set(left, leftNeighbors);
      const rightNeighbors = adjacency.get(right) ?? new Set<string>();
      rightNeighbors.add(left);
      adjacency.set(right, rightNeighbors);
    };
    for (const route of this.committed.values()) {
      for (const edgeId of route.edgePath) {
        const edge = this.prepared.edges[edgeId]!;
        const demand = this.prepared.demandById.get(route.routeId)!;
        const foreignOwners = this.getForeignOwners(edge, demand);
        for (const foreignOwner of foreignOwners) {
          addPair(route.routeId, foreignOwner);
        }
      }
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const routeId of [...adjacency.keys()].sort()) {
      if (visited.has(routeId)) continue;
      const component: string[] = [];
      const pending = [routeId];
      visited.add(routeId);
      while (pending.length > 0) {
        const current = pending.pop()!;
        component.push(current);
        for (const neighbor of adjacency.get(current) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
      components.push(component.sort());
    }
    return components;
  }

  private validateFinalRouting() {
    const missingDemand = this.prepared.demands.find(
      (demand) => !this.committed.has(demand.routeId),
    );
    if (missingDemand) {
      throw new Error(
        `Missing routed demand "${missingDemand.routeId}" from final solution`,
      );
    }
    this.validateNetConnectivity();
    for (const route of this.committed.values()) {
      for (const edgeId of route.edgePath) {
        const edge = this.prepared.edges[edgeId]!;
        if (edge.kind !== "fixed_via_transition") continue;
        const via = this.prepared.fixedViaById.get(edge.prefabViaId);
        if (!via) {
          throw new Error(
            `Route "${route.routeId}" uses unknown via "${edge.prefabViaId}"`,
          );
        }
        const from = this.prepared.nodes[edge.fromNode]!;
        const to = this.prepared.nodes[edge.toNode]!;
        if (
          from.x !== via.x ||
          from.y !== via.y ||
          to.x !== via.x ||
          to.y !== via.y
        ) {
          throw new Error(
            `Layer transition for "${route.routeId}" is not centered on its prefabricated via`,
          );
        }
      }
    }
    const routes = [...this.committed.values()];
    for (let firstIndex = 0; firstIndex < routes.length; firstIndex++) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < routes.length;
        secondIndex++
      ) {
        const first = routes[firstIndex]!;
        const second = routes[secondIndex]!;
        if (first.netId === second.netId) continue;
        const firstDemand = this.prepared.demandById.get(first.routeId)!;
        const secondDemand = this.prepared.demandById.get(second.routeId)!;
        const clearance = Math.max(
          this.prepared.options.gridClearance,
          this.prepared.input.minTraceToPadEdgeClearance ?? 0,
        );
        const minimumCenterDistance =
          firstDemand.width / 2 + secondDemand.width / 2 + clearance;
        const secondTraceEdges = new Set(
          second.edgePath.filter(
            (edgeId) => this.prepared.edges[edgeId]!.kind === "trace",
          ),
        );
        for (const firstEdgeId of first.edgePath) {
          const firstEdge = this.prepared.edges[firstEdgeId]!;
          if (firstEdge.kind !== "trace") continue;
          let violatesClearance = false;
          const conflictCount = this.getConflictCount(firstEdge);
          for (let index = 0; index < conflictCount; index++) {
            const secondEdgeId = this.getConflictEdgeId(firstEdge, index);
            if (!secondTraceEdges.has(secondEdgeId)) continue;
            const secondEdge = this.prepared.edges[secondEdgeId]!;
            if (
              secondEdge.kind === "trace" &&
              segmentDistance(
                this.prepared.nodes[firstEdge.fromNode]!,
                this.prepared.nodes[firstEdge.toNode]!,
                this.prepared.nodes[secondEdge.fromNode]!,
                this.prepared.nodes[secondEdge.toNode]!,
              ) <
                minimumCenterDistance - 1e-7
            ) {
              violatesClearance = true;
              break;
            }
          }
          if (violatesClearance) {
            throw new Error(
              `Final routes "${first.routeId}" and "${second.routeId}" violate trace clearance`,
            );
          }
        }
      }
    }
  }

  private validateNetConnectivity() {
    const disconnectedDemand = this.getDisconnectedDemands()[0];
    if (!disconnectedDemand) return;
    throw new Error(
      `Final net "${disconnectedDemand.netId}" is disconnected between "${disconnectedDemand.sourcePointId ?? disconnectedDemand.sourceNode}" and "${disconnectedDemand.targetPointId ?? disconnectedDemand.targetNode}"`,
    );
  }

  private getDisconnectedDemands() {
    const parentByNet = new Map<string, Map<number, number>>();
    const getParent = (netId: string) => {
      const parent = parentByNet.get(netId) ?? new Map<number, number>();
      parentByNet.set(netId, parent);
      return parent;
    };
    const find = (parent: Map<number, number>, node: number): number => {
      const currentParent = parent.get(node) ?? node;
      parent.set(node, currentParent);
      if (currentParent === node) return node;
      const root = find(parent, currentParent);
      parent.set(node, root);
      return root;
    };
    const union = (netId: string, leftNode: number, rightNode: number) => {
      const parent = getParent(netId);
      const leftRoot = find(parent, leftNode);
      const rightRoot = find(parent, rightNode);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    for (const route of this.committed.values()) {
      const parent = getParent(route.netId);
      for (let index = 0; index < route.nodePath.length; index++) {
        const node = route.nodePath[index]!;
        find(parent, node);
        if (index === 0) continue;
        const previous = route.nodePath[index - 1]!;
        union(route.netId, previous, node);
      }
    }

    // The sparse visibility graph deliberately omits the Cartesian product of
    // every feature-aligned X and Y coordinate. Consequently, two same-net
    // traces can cross between graph nodes even though the emitted copper is
    // physically connected. Treat exact same-layer segment intersections as
    // connectivity; nearby parallel traces still remain separate.
    for (const route of this.committed.values()) {
      for (const edgeId of route.edgePath) {
        const edge = this.prepared.edges[edgeId]!;
        if (edge.kind !== "trace") continue;
        const from = this.prepared.nodes[edge.fromNode]!;
        const to = this.prepared.nodes[edge.toNode]!;
        const conflictCount = this.getConflictCount(edge);
        for (let index = 0; index < conflictCount; index++) {
          const candidateEdgeId = this.getConflictEdgeId(edge, index);
          const candidateEdge = this.prepared.edges[candidateEdgeId]!;
          if (candidateEdge.kind !== "trace") continue;
          const candidateFrom = this.prepared.nodes[candidateEdge.fromNode]!;
          const candidateTo = this.prepared.nodes[candidateEdge.toNode]!;
          if (
            from.layer !== candidateFrom.layer ||
            segmentDistance(from, to, candidateFrom, candidateTo) > 1e-7
          ) {
            continue;
          }
          for (const candidateRouteIndex of this.edgeOwners.get(
            candidateEdgeId,
          ) ?? []) {
            const candidateRouteId = this.routeIdByIndex[candidateRouteIndex]!;
            const candidateRoute = this.committed.get(candidateRouteId);
            if (candidateRoute?.netId !== route.netId) continue;
            union(route.netId, edge.fromNode, candidateEdge.fromNode);
          }
        }
      }
    }
    return this.prepared.demands.filter((demand) => {
      const parent = getParent(demand.netId);
      return (
        find(parent, demand.sourceNode) !== find(parent, demand.targetNode)
      );
    });
  }

  private fail(message: string) {
    this.error = message;
    this.failed = true;
    this.activeSearch = null;
  }

  private getStats(): BiscuitBoardRoutingStats {
    const fixedViaTransitionCount = this.committedFixedViaTransitionCount;
    return {
      routeCount: this.prepared.demandById.size,
      routedCount: this.committed.size,
      pendingCount: this.pending.length + (this.activeSearch ? 1 : 0),
      ripCount: this.totalRipCount,
      expandedStateCount: this.totalExpandedStateCount,
      fixedViaTransitionCount,
      graphNodeCount: this.prepared.nodes.length,
      graphEdgeCount: this.prepared.edges.length,
      negotiationPassCount: this.negotiationPassCount,
      conflictRouteCount: this.lastConflictRouteCount,
      adaptivePriorityChangeCount: this.adaptivePriorityChangeCount,
      maximumActiveSearchNodeCount: this.maximumActiveSearchNodeCount,
      maximumOpenHeapSize: this.maximumOpenHeapSize,
      searchCount: this.searchCount,
      failedSearchCount: this.failedSearchCount,
      maximumForeignOwnerCacheEntries: this.maximumForeignOwnerCacheEntries,
      nodeAllowanceCacheHitCount: this.nodeAllowanceCacheHitCount,
      nodeAllowanceCacheMissCount: this.nodeAllowanceCacheMissCount,
      edgeAllowanceCacheHitCount: this.edgeAllowanceCacheHitCount,
      edgeAllowanceCacheMissCount: this.edgeAllowanceCacheMissCount,
      foreignOwnerCacheHitCount: this.foreignOwnerCacheHitCount,
      foreignOwnerCacheMissCount: this.foreignOwnerCacheMissCount,
      targetHeuristicCacheHitCount: this.targetHeuristicCacheHitCount,
      targetHeuristicCacheMissCount: this.targetHeuristicCacheMissCount,
      maximumHeuristicWeight: this.maximumHeuristicWeightUsed,
      activeRouteId: this.activeSearch?.demand.routeId ?? null,
      activeExpandedStateCount: this.activeSearch?.expanded ?? 0,
    };
  }

  private updateStats() {
    if (this.activeSearch) {
      this.maximumActiveSearchNodeCount = Math.max(
        this.maximumActiveSearchNodeCount,
        this.activeSearch.nodes.length,
      );
      this.maximumOpenHeapSize = Math.max(
        this.maximumOpenHeapSize,
        this.activeSearch.open.size,
      );
      this.maximumForeignOwnerCacheEntries = Math.max(
        this.maximumForeignOwnerCacheEntries,
        this.activeSearch.foreignOwnerCacheEntryCount,
      );
    }
    this.stats = this.getStats();
  }

  override getOutput(): BiscuitBoardRoutingSolution {
    return {
      routes: [...this.committed.values()].sort((left, right) =>
        left.routeId.localeCompare(right.routeId),
      ),
      traces: [],
      stats: this.getStats(),
    };
  }

  override visualize(): GraphicsObject {
    const graphics = visualizePreparedProblem(
      this.prepared,
      this.committed.values(),
    );
    const conflictLines: NonNullable<GraphicsObject["lines"]> = [];
    for (const route of this.committed.values()) {
      const demand = this.prepared.demandById.get(route.routeId);
      if (!demand) continue;
      for (const edgeId of route.edgePath) {
        const edge = this.prepared.edges[edgeId]!;
        if (
          edge.kind !== "trace" ||
          this.getForeignOwners(edge, demand).length === 0
        ) {
          continue;
        }
        conflictLines.push({
          points: [
            this.prepared.nodes[edge.fromNode]!,
            this.prepared.nodes[edge.toNode]!,
          ],
          strokeColor: "#dc2626",
          strokeWidth: Math.max(0.26, demand.width + 0.08),
          label: `clearance conflict · ${route.routeId}`,
        });
      }
    }
    return {
      ...graphics,
      title: `Rip-and-replace fixed-via router (${this.committed.size}/${this.prepared.demandById.size}, ${this.totalRipCount} rips, ${conflictLines.length} conflict edges)`,
      lines: [...(graphics.lines ?? []), ...conflictLines],
    };
  }

  override preview() {
    return this.visualize();
  }
}

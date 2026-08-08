import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import {
  obstacleBounds,
  pointDistance,
  segmentDistance,
  segmentIntersectsRectInterior,
  visualizePreparedProblem,
} from "./geometry";
import { MinHeap } from "./min-heap";
import type {
  BiscuitBoardRoutingSolution,
  BiscuitBoardRoutingStats,
  PreparedBiscuitRoutingProblem,
  RouteDemand,
  RoutedConnection,
  RoutingEdge,
} from "./types";

interface SearchNode {
  graphNode: number;
  g: number;
  parentIndex: number;
  blockers: string[];
  edgeFromParent: number | null;
}

interface ActiveSearch {
  demand: RouteDemand;
  allowBlockers: boolean;
  sourceNode: number;
  targetNodes: Set<number>;
  targetTreesByLayer: Map<string, TargetKdNode | null>;
  nodes: SearchNode[];
  open: MinHeap<number>;
  bestCostByState: Map<string, number>;
  expanded: number;
}

interface TargetKdNode {
  x: number;
  y: number;
  axis: 0 | 1;
  left: TargetKdNode | null;
  right: TargetKdNode | null;
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
  const axisDifference = tree.axis === 0 ? dx : dy;
  const nearBranch = axisDifference <= 0 ? tree.left : tree.right;
  const farBranch = axisDifference <= 0 ? tree.right : tree.left;
  best = nearestTargetDistanceSquared(nearBranch, x, y, best);
  if (axisDifference * axisDifference < best) {
    best = nearestTargetDistanceSquared(farBranch, x, y, best);
  }
  return best;
};

const insertSortedUnique = (values: readonly string[], additions: string[]) =>
  [...new Set([...values, ...additions])].sort();

const deterministicOrderKey = (value: string, pass: number) => {
  let hash = (2166136261 ^ pass) >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
};

export class RipUpRubberBandSolver extends BaseSolver {
  private readonly committed = new Map<string, RoutedConnection>();
  private readonly pending: RouteDemand[];
  private readonly edgeOwners = new Map<number, Set<string>>();
  private readonly nodeOwners = new Map<number, Set<string>>();
  private readonly historyCostByEdge = new Map<number, number>();
  private readonly historyCostByNode = new Map<number, number>();
  private readonly ripCountByRoute = new Map<string, number>();
  private readonly conflictComponentAttemptCount = new Map<string, number>();
  private activeSearch: ActiveSearch | null = null;
  private connectivityRepairCount = 0;
  private totalRipCount = 0;
  private totalExpandedStateCount = 0;
  private negotiationPassCount = 0;
  private lastConflictRouteCount = 0;

  constructor(public readonly prepared: PreparedBiscuitRoutingProblem) {
    super();
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
        left.routeId.localeCompare(right.routeId);
      return prepared.options.routeOrder === "shortest_first"
        ? -comparison
        : comparison;
    };
    this.pending =
      prepared.options.routeOrder === "input"
        ? [...prepared.demands]
        : [...prepared.demands].sort(compareByDistance);
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

  override _step() {
    if (!this.activeSearch) {
      const demand = this.pending.shift();
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

  private createSearch(
    demand: RouteDemand,
    allowBlockers: boolean,
  ): ActiveSearch {
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
    const targetTreesByLayer = new Map(
      [...targetPointsByLayer].map(([layer, points]) => [
        layer,
        buildTargetKdTree(points),
      ]),
    );
    const open = new MinHeap<number>();
    open.push(this.heuristicToTargets(sourceNode, targetTreesByLayer), 0);
    return {
      demand,
      allowBlockers,
      sourceNode,
      targetNodes,
      targetTreesByLayer,
      nodes: [
        {
          graphNode: sourceNode,
          g: 0,
          parentIndex: -1,
          blockers: [],
          edgeFromParent: null,
        },
      ],
      open,
      bestCostByState: new Map([[this.stateKey(sourceNode, null), 0]]),
      expanded: 0,
    };
  }

  private getOwnedNodesForNet(netId: string) {
    const ownedNodes = new Set<number>();
    for (const [nodeIndex, routeIds] of this.nodeOwners) {
      if (
        [...routeIds].some(
          (routeId) => this.prepared.demandById.get(routeId)?.netId === netId,
        )
      ) {
        ownedNodes.add(nodeIndex);
      }
    }
    return ownedNodes;
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

  private stateKey(graphNode: number, edgeFromParent: number | null) {
    const node = this.prepared.nodes[graphNode]!;
    if (node.kind !== "fixed_via") return String(graphNode);
    const arrivalKind =
      edgeFromParent === null
        ? "start"
        : this.prepared.edges[edgeFromParent]!.kind;
    return `${graphNode}:${arrivalKind}`;
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
  ) {
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
    return best;
  }

  private expandOneState() {
    const search = this.activeSearch;
    if (!search) return;
    const searchNodeIndex = search.open.pop();
    if (searchNodeIndex === undefined) {
      if (!search.allowBlockers) {
        // Most routes have a free path, frequently by using the bottom layer
        // through fixed vias. Searching that zero-blocker state space first
        // avoids the combinatorial blocker subsets that tiny-hypergraph also
        // treats as an exceptional rip/re-route phase.
        this.activeSearch = this.createSearch(search.demand, true);
        return;
      }
      this.fail(
        `No fixed-via route found for "${search.demand.routeId}" with at most ${this.prepared.options.maxBlockersPerSearch} blockers`,
      );
      return;
    }
    const current = search.nodes[searchNodeIndex]!;
    const bestCost = search.bestCostByState.get(
      this.stateKey(current.graphNode, current.edgeFromParent),
    );
    if (bestCost === undefined || current.g > bestCost + 1e-9) return;
    search.expanded++;
    this.totalExpandedStateCount++;

    if (search.targetNodes.has(current.graphNode)) {
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
    if (!this.nodeAllowsDemand(toNode, search.demand)) return;
    if (!this.edgeAllowsDemand(edge, search.demand)) return;

    const foreignOwners = this.getForeignOwners(edge, search.demand);
    if (!search.allowBlockers && foreignOwners.length > 0) return;
    if (
      foreignOwners.some(
        (routeId) =>
          (this.ripCountByRoute.get(routeId) ?? 0) >=
          this.prepared.options.maxRipsPerRoute,
      )
    ) {
      return;
    }
    const nextBlockers = insertSortedUnique(parent.blockers, foreignOwners);
    if (nextBlockers.length > this.prepared.options.maxBlockersPerSearch)
      return;
    const presentCongestionCost =
      this.prepared.options.ripCost * (this.negotiationPassCount + 1) ** 2;
    const nextG =
      parent.g +
      edge.cost +
      (this.historyCostByEdge.get(edgeId) ?? 0) +
      (this.historyCostByNode.get(toNode) ?? 0) +
      foreignOwners.length *
        (presentCongestionCost + this.prepared.options.crossingCost);
    const key = this.stateKey(toNode, edgeId);
    if (
      nextG >= (search.bestCostByState.get(key) ?? Number.POSITIVE_INFINITY)
    ) {
      return;
    }
    const nextIndex = search.nodes.length;
    search.nodes.push({
      graphNode: toNode,
      g: nextG,
      parentIndex,
      blockers: nextBlockers,
      edgeFromParent: edgeId,
    });
    search.bestCostByState.set(key, nextG);
    search.open.push(
      nextG + this.heuristicToTargets(toNode, search.targetTreesByLayer),
      nextIndex,
    );
  }

  private nodeAllowsDemand(nodeIndex: number, demand: RouteDemand) {
    const node = this.prepared.nodes[nodeIndex]!;
    return (
      node.kind !== "terminal" ||
      node.terminalConnectionNames.some((connectionName) =>
        [
          demand.connectionName,
          demand.netId,
          ...(demand.allowedConnectionNames ?? []),
        ].includes(connectionName),
      )
    );
  }

  private edgeAllowsDemand(edge: RoutingEdge, demand: RouteDemand) {
    if (edge.kind === "fixed_via_transition") return true;
    const from = this.prepared.nodes[edge.fromNode]!;
    const to = this.prepared.nodes[edge.toNode]!;
    for (const obstacleIndex of edge.blockingObstacleIndexes) {
      const obstacle = this.prepared.input.obstacles[obstacleIndex]!;
      const clearance = Math.max(
        this.prepared.options.gridClearance,
        this.prepared.input.minTraceToPadEdgeClearance ?? 0,
      );
      if (
        !segmentIntersectsRectInterior(
          from,
          to,
          obstacleBounds(obstacle, demand.width / 2 + clearance),
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

  private getForeignOwners(edge: RoutingEdge, demand: RouteDemand) {
    const ownerRouteIds = new Set<string>();
    const addForeign = (
      routeIds: Iterable<string> | undefined,
      candidateEdge?: RoutingEdge,
    ) => {
      for (const routeId of routeIds ?? []) {
        const ownerDemand = this.prepared.demandById.get(routeId);
        if (!ownerDemand || ownerDemand.netId === demand.netId) continue;
        if (
          edge.kind === "trace" &&
          candidateEdge?.kind === "trace" &&
          edge.edgeId !== candidateEdge.edgeId
        ) {
          const from = this.prepared.nodes[edge.fromNode]!;
          const to = this.prepared.nodes[edge.toNode]!;
          const candidateFrom = this.prepared.nodes[candidateEdge.fromNode]!;
          const candidateTo = this.prepared.nodes[candidateEdge.toNode]!;
          const clearance = Math.max(
            this.prepared.options.gridClearance,
            this.prepared.input.minTraceToPadEdgeClearance ?? 0,
          );
          const minimumCenterDistance =
            demand.width / 2 + ownerDemand.width / 2 + clearance;
          if (
            segmentDistance(from, to, candidateFrom, candidateTo) >=
            minimumCenterDistance - 1e-7
          ) {
            continue;
          }
        }
        ownerRouteIds.add(routeId);
      }
    };
    addForeign(this.nodeOwners.get(edge.fromNode));
    addForeign(this.nodeOwners.get(edge.toNode));
    if (edge.kind === "trace") {
      addForeign(this.edgeOwners.get(edge.edgeId));
      for (const conflictEdgeId of edge.conflictEdgeIds) {
        addForeign(
          this.edgeOwners.get(conflictEdgeId),
          this.prepared.edges[conflictEdgeId],
        );
      }
    }
    return [...ownerRouteIds].sort();
  }

  private commitGoal(search: ActiveSearch, goalIndex: number) {
    const goal = search.nodes[goalIndex]!;
    // Keep the broad routing phase conflict-free. If repeated rip-and-replace
    // reaches a small cycling tail, commit its negotiated paths and let the
    // component repair phase repack only those remaining conflicts.
    const shouldRipImmediately =
      this.totalRipCount < this.prepared.demands.length * 2;
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
    for (const blockerRouteId of shouldRipImmediately ? goal.blockers : []) {
      const blockerRoute = this.committed.get(blockerRouteId);
      for (const edgeId of blockerRoute?.edgePath ?? []) {
        this.historyCostByEdge.set(
          edgeId,
          (this.historyCostByEdge.get(edgeId) ?? 0) +
            this.prepared.options.historyIncrement,
        );
      }
      for (const nodeIndex of blockerRoute?.nodePath ?? []) {
        this.historyCostByNode.set(
          nodeIndex,
          (this.historyCostByNode.get(nodeIndex) ?? 0) +
            this.prepared.options.historyIncrement,
        );
      }
      this.uncommitRoute(blockerRouteId);
      if (this.failed) return;
      const blockerDemand = this.prepared.demandById.get(blockerRouteId);
      if (blockerDemand) this.queueDemand(blockerDemand.routeId);
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
      blockerRouteIds: goal.blockers,
    };
    this.committed.set(route.routeId, route);
    for (const nodeIndex of nodePath) {
      const owners = this.nodeOwners.get(nodeIndex) ?? new Set<string>();
      owners.add(route.routeId);
      this.nodeOwners.set(nodeIndex, owners);
    }
    for (const edgeId of edgePath) {
      const edge = this.prepared.edges[edgeId]!;
      if (edge.kind !== "trace") continue;
      const owners = this.edgeOwners.get(edgeId) ?? new Set<string>();
      owners.add(route.routeId);
      this.edgeOwners.set(edgeId, owners);
    }
    this.activeSearch = null;
  }

  private uncommitRoute(routeId: string) {
    const route = this.committed.get(routeId);
    if (!route) return;
    for (const edgeId of route.edgePath) {
      const owners = this.edgeOwners.get(edgeId);
      owners?.delete(routeId);
      if (owners?.size === 0) this.edgeOwners.delete(edgeId);
    }
    for (const nodeIndex of route.nodePath) {
      const owners = this.nodeOwners.get(nodeIndex);
      owners?.delete(routeId);
      if (owners?.size === 0) this.nodeOwners.delete(nodeIndex);
    }
    this.committed.delete(routeId);
    this.ripCountByRoute.set(
      routeId,
      (this.ripCountByRoute.get(routeId) ?? 0) + 1,
    );
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

  private finishOrScheduleNegotiationPass() {
    const conflictComponents = this.getConflictComponents();
    const allConflictingRouteIds = new Set(conflictComponents.flat());
    this.lastConflictRouteCount = allConflictingRouteIds.size;
    if (allConflictingRouteIds.size === 0) {
      const disconnectedDemand = this.getDisconnectedDemands().sort((a, b) =>
        a.routeId.localeCompare(b.routeId),
      )[0];
      if (disconnectedDemand) {
        const repairDemand: RouteDemand = {
          ...disconnectedDemand,
          routeId: `connectivity-repair:${disconnectedDemand.netId}:${this.connectivityRepairCount++}`,
        };
        this.prepared.demandById.set(repairDemand.routeId, repairDemand);
        this.pending.push(repairDemand);
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

    // Repair one connected conflict component at a time. Independent
    // crossings on opposite sides of a board should not destabilize each
    // other during a local rubber-band operation.
    const orderedConflictComponents = conflictComponents.sort(
      (left, right) =>
        left.length - right.length || left[0]!.localeCompare(right[0]!),
    );
    const conflictingRouteIds = new Set(
      orderedConflictComponents[
        this.negotiationPassCount % orderedConflictComponents.length
      ]!,
    );
    const componentKey = [...conflictingRouteIds].sort().join("|");
    const componentAttempt =
      (this.conflictComponentAttemptCount.get(componentKey) ?? 0) + 1;
    this.conflictComponentAttemptCount.set(componentKey, componentAttempt);
    if (conflictingRouteIds.size <= 8) {
      const haloRouteCount = Math.min(
        4,
        1 + Math.floor((componentAttempt - 1) / 2),
      );
      for (let index = 0; index < haloRouteCount; index++) {
        this.addOneNearbyTerminalRoute(
          conflictingRouteIds,
          (componentAttempt - 1) * 4 + index,
        );
      }
    }

    this.negotiationPassCount++;
    for (const routeId of conflictingRouteIds) {
      const route = this.committed.get(routeId);
      for (const edgeId of route?.edgePath ?? []) {
        this.historyCostByEdge.set(
          edgeId,
          (this.historyCostByEdge.get(edgeId) ?? 0) +
            this.prepared.options.historyIncrement,
        );
      }
      for (const nodeIndex of route?.nodePath ?? []) {
        this.historyCostByNode.set(
          nodeIndex,
          (this.historyCostByNode.get(nodeIndex) ?? 0) +
            this.prepared.options.historyIncrement,
        );
      }
    }
    const routeIdsToReroute = [...conflictingRouteIds].sort();
    const isCompactRepair = routeIdsToReroute.length <= 12;
    const rerouteDemands = routeIdsToReroute
      .map((routeId) => this.prepared.demandById.get(routeId))
      .filter((demand): demand is RouteDemand => Boolean(demand))
      .filter((demand) => {
        if (
          (this.ripCountByRoute.get(demand.routeId) ?? 0) >=
          this.prepared.options.maxRipsPerRoute
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        if (!isCompactRepair) {
          return (
            this.prepared.demands.indexOf(left) -
            this.prepared.demands.indexOf(right)
          );
        }
        return (
          deterministicOrderKey(left.routeId, this.negotiationPassCount) -
            deterministicOrderKey(right.routeId, this.negotiationPassCount) ||
          left.routeId.localeCompare(right.routeId)
        );
      });

    if (rerouteDemands.length === 0) {
      this.fail(
        `Negotiated routing stalled with ${conflictingRouteIds.size} conflicting routes`,
      );
      return;
    }
    if (isCompactRepair) {
      // Release a compact conflicting component before attempting repair. If
      // its routes are removed one at a time, the routes waiting to be
      // rerouted still occupy every alternative corridor and the negotiation
      // stalls in a local minimum (the RP2040 QFN escape is a compact example).
      for (const demand of rerouteDemands) this.uncommitRoute(demand.routeId);
      if (this.failed) return;
    }
    for (const demand of rerouteDemands) this.queueDemand(demand.routeId);
    this.updateStats();
  }

  private addOneNearbyTerminalRoute(routeIds: Set<string>, offset: number) {
    const endpointNodes = [...routeIds].flatMap((routeId) => {
      const demand = this.prepared.demandById.get(routeId);
      return demand ? [demand.sourceNode, demand.targetNode] : [];
    });
    const candidates = this.prepared.demands
      .filter(
        (demand) =>
          !routeIds.has(demand.routeId) && this.committed.has(demand.routeId),
      )
      .map((demand) => ({
        routeId: demand.routeId,
        distance: Math.min(
          ...endpointNodes.flatMap((endpointNode) =>
            [demand.sourceNode, demand.targetNode].map((candidateNode) =>
              pointDistance(
                this.prepared.nodes[endpointNode]!,
                this.prepared.nodes[candidateNode]!,
              ),
            ),
          ),
        ),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          left.routeId.localeCompare(right.routeId),
      );
    if (candidates.length === 0) return;
    routeIds.add(candidates[offset % candidates.length]!.routeId);
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
          if (
            firstEdge.conflictEdgeIds.some((edgeId) => {
              if (!secondTraceEdges.has(edgeId)) return false;
              const secondEdge = this.prepared.edges[edgeId]!;
              if (secondEdge.kind !== "trace") return false;
              return (
                segmentDistance(
                  this.prepared.nodes[firstEdge.fromNode]!,
                  this.prepared.nodes[firstEdge.toNode]!,
                  this.prepared.nodes[secondEdge.fromNode]!,
                  this.prepared.nodes[secondEdge.toNode]!,
                ) <
                minimumCenterDistance - 1e-7
              );
            })
          ) {
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
    for (const route of this.committed.values()) {
      const parent = getParent(route.netId);
      for (let index = 0; index < route.nodePath.length; index++) {
        const node = route.nodePath[index]!;
        find(parent, node);
        if (index === 0) continue;
        const previous = route.nodePath[index - 1]!;
        const previousRoot = find(parent, previous);
        const nodeRoot = find(parent, node);
        if (previousRoot !== nodeRoot) parent.set(nodeRoot, previousRoot);
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
    let fixedViaTransitionCount = 0;
    for (const route of this.committed.values()) {
      fixedViaTransitionCount += route.edgePath.filter(
        (edgeId) =>
          this.prepared.edges[edgeId]!.kind === "fixed_via_transition",
      ).length;
    }
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
    };
  }

  private updateStats() {
    this.stats = {
      ...this.getStats(),
      activeRouteId: this.activeSearch?.demand.routeId ?? null,
      activeExpandedStateCount: this.activeSearch?.expanded ?? 0,
    };
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
    return {
      ...graphics,
      title: `Rip-and-replace fixed-via router (${this.committed.size}/${this.prepared.demandById.size}, ${this.totalRipCount} rips)`,
    };
  }

  override preview() {
    return this.visualize();
  }
}

import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { pointDistance, visualizePreparedProblem } from "./geometry";
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
  nodes: SearchNode[];
  open: MinHeap<number>;
  bestCostByState: Map<string, number>;
  expanded: number;
}

// Blocker sets are carried to the goal so the selected owners can be ripped,
// but they are not part of the dominance key. Keeping every blocker subset is
// exponential on a real board; one lowest-cost label per graph site is the
// bounded approximation used by this negotiated router.
const stateKey = (graphNode: number) => String(graphNode);

const insertSortedUnique = (values: readonly string[], additions: string[]) =>
  [...new Set([...values, ...additions])].sort();

export class RipUpRubberBandSolver extends BaseSolver {
  private readonly committed = new Map<string, RoutedConnection>();
  private readonly pending: RouteDemand[];
  private readonly edgeOwners = new Map<number, Set<string>>();
  private readonly nodeOwners = new Map<number, Set<string>>();
  private readonly historyCostByEdge = new Map<number, number>();
  private readonly ripCountByRoute = new Map<string, number>();
  private activeSearch: ActiveSearch | null = null;
  private totalRipCount = 0;
  private totalExpandedStateCount = 0;

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
        this.validateFinalRouting();
        this.solved = true;
        this.progress = 1;
        this.updateStats();
        return;
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
      this.prepared.demands.length === 0
        ? 1
        : this.committed.size / this.prepared.demands.length;
    this.updateStats();
  }

  private createSearch(
    demand: RouteDemand,
    allowBlockers: boolean,
  ): ActiveSearch {
    const open = new MinHeap<number>();
    open.push(this.heuristic(demand.sourceNode, demand.targetNode), 0);
    return {
      demand,
      allowBlockers,
      nodes: [
        {
          graphNode: demand.sourceNode,
          g: 0,
          parentIndex: -1,
          blockers: [],
          edgeFromParent: null,
        },
      ],
      open,
      bestCostByState: new Map([[stateKey(demand.sourceNode), 0]]),
      expanded: 0,
    };
  }

  private heuristic(fromNode: number, toNode: number) {
    const from = this.prepared.nodes[fromNode]!;
    const to = this.prepared.nodes[toNode]!;
    return (
      pointDistance(from, to) +
      (from.layer === to.layer ? 0 : this.prepared.options.viaTransitionCost)
    );
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
    const bestCost = search.bestCostByState.get(stateKey(current.graphNode));
    if (bestCost === undefined || current.g > bestCost + 1e-9) return;
    search.expanded++;
    this.totalExpandedStateCount++;

    if (current.graphNode === search.demand.targetNode) {
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

    const foreignOwners = this.getForeignOwners(edge, search.demand.netId);
    if (!search.allowBlockers && foreignOwners.length > 0) return;
    for (const ownerRouteId of foreignOwners) {
      if (
        !this.committed.has(ownerRouteId) ||
        (this.ripCountByRoute.get(ownerRouteId) ?? 0) >=
          this.prepared.options.maxRipsPerRoute
      ) {
        return;
      }
    }
    const nextBlockers = insertSortedUnique(parent.blockers, foreignOwners);
    if (nextBlockers.length > this.prepared.options.maxBlockersPerSearch)
      return;
    const newlyAddedBlockers = nextBlockers.length - parent.blockers.length;
    const nextG =
      parent.g +
      edge.cost +
      (this.historyCostByEdge.get(edgeId) ?? 0) +
      foreignOwners.length * this.prepared.options.crossingCost +
      newlyAddedBlockers * this.prepared.options.ripCost;
    const key = stateKey(toNode);
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
      nextG + this.heuristic(toNode, search.demand.targetNode),
      nextIndex,
    );
  }

  private nodeAllowsDemand(nodeIndex: number, demand: RouteDemand) {
    const node = this.prepared.nodes[nodeIndex]!;
    return (
      node.kind !== "terminal" ||
      node.terminalConnectionNames.includes(demand.connectionName)
    );
  }

  private edgeAllowsDemand(edge: RoutingEdge, demand: RouteDemand) {
    if (edge.kind === "fixed_via_transition") return true;
    const from = this.prepared.nodes[edge.fromNode]!;
    const to = this.prepared.nodes[edge.toNode]!;
    for (const obstacleIndex of edge.blockingObstacleIndexes) {
      const obstacle = this.prepared.input.obstacles[obstacleIndex]!;
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

  private getForeignOwners(edge: RoutingEdge, netId: string) {
    const ownerRouteIds = new Set<string>();
    const addForeign = (routeIds: Iterable<string> | undefined) => {
      for (const routeId of routeIds ?? []) {
        const demand = this.prepared.demandById.get(routeId);
        if (demand && demand.netId !== netId) ownerRouteIds.add(routeId);
      }
    };
    addForeign(this.nodeOwners.get(edge.fromNode));
    addForeign(this.nodeOwners.get(edge.toNode));
    if (edge.kind === "trace") {
      addForeign(this.edgeOwners.get(edge.edgeId));
      for (const conflictEdgeId of edge.conflictEdgeIds) {
        addForeign(this.edgeOwners.get(conflictEdgeId));
      }
    }
    return [...ownerRouteIds].sort();
  }

  private commitGoal(search: ActiveSearch, goalIndex: number) {
    const goal = search.nodes[goalIndex]!;
    if (
      this.totalRipCount + goal.blockers.length >
      this.prepared.options.maxTotalRips
    ) {
      this.fail(
        `Total rip limit (${this.prepared.options.maxTotalRips}) reached`,
      );
      return;
    }
    for (const blocker of goal.blockers) this.ripRoute(blocker);

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

  private ripRoute(routeId: string) {
    const route = this.committed.get(routeId);
    if (!route) return;
    for (const edgeId of route.edgePath) {
      this.historyCostByEdge.set(
        edgeId,
        (this.historyCostByEdge.get(edgeId) ?? 0) +
          this.prepared.options.historyIncrement,
      );
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
    const demand = this.prepared.demandById.get(routeId);
    if (
      demand &&
      !this.pending.some((candidate) => candidate.routeId === routeId)
    ) {
      this.pending.push(demand);
    }
  }

  private validateFinalRouting() {
    if (this.committed.size !== this.prepared.demands.length) {
      throw new Error(
        `Expected ${this.prepared.demands.length} routes, got ${this.committed.size}`,
      );
    }
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
        const secondTraceEdges = new Set(
          second.edgePath.filter(
            (edgeId) => this.prepared.edges[edgeId]!.kind === "trace",
          ),
        );
        for (const firstEdgeId of first.edgePath) {
          const firstEdge = this.prepared.edges[firstEdgeId]!;
          if (firstEdge.kind !== "trace") continue;
          if (
            firstEdge.conflictEdgeIds.some((edgeId) =>
              secondTraceEdges.has(edgeId),
            )
          ) {
            throw new Error(
              `Final routes "${first.routeId}" and "${second.routeId}" violate trace clearance`,
            );
          }
        }
      }
    }
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
      routeCount: this.prepared.demands.length,
      routedCount: this.committed.size,
      pendingCount: this.pending.length + (this.activeSearch ? 1 : 0),
      ripCount: this.totalRipCount,
      expandedStateCount: this.totalExpandedStateCount,
      fixedViaTransitionCount,
      graphNodeCount: this.prepared.nodes.length,
      graphEdgeCount: this.prepared.edges.length,
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
      routes: this.prepared.demands.flatMap((demand) => {
        const route = this.committed.get(demand.routeId);
        return route ? [route] : [];
      }),
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
      title: `Rip-and-replace fixed-via router (${this.committed.size}/${this.prepared.demands.length}, ${this.totalRipCount} rips)`,
    };
  }

  override preview() {
    return this.visualize();
  }
}

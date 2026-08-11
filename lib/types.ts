import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";

export type Point = { x: number; y: number };

export interface RectBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BiscuitBoardAutorouterOptions {
  routeOrder?:
    | "longest_first"
    | "shortest_first"
    | "signal_longest_first"
    | "input";
  gridPitch?: number;
  /** Minimum edge-to-edge copper clearance used by graph generation and cleanup. */
  gridClearance?: number;
  /** Use rotated obstacle envelopes during graph generation instead of deferring them to cleanup. */
  respectObstacleRotationInGraph?: boolean;
  viaTransitionCost?: number;
  ripCost?: number;
  crossingCost?: number;
  historyIncrement?: number;
  maxBlockersPerSearch?: number;
  maxRipsPerRoute?: number;
  maxTotalRips?: number;
  maxSearchStates?: number;
  expansionsPerStep?: number;
  /** Expand routed copper toward its nominal width after clearance cleanup. */
  expandTraces?: boolean;
  /** Improve trace spacing, consolidate same-net copper, and chamfer corners. */
  beautifyTraces?: boolean;
}

export interface NormalizedBiscuitBoardAutorouterOptions {
  routeOrder:
    | "longest_first"
    | "shortest_first"
    | "signal_longest_first"
    | "input";
  gridPitch: number;
  gridClearance: number;
  respectObstacleRotationInGraph: boolean;
  viaTransitionCost: number;
  ripCost: number;
  crossingCost: number;
  historyIncrement: number;
  maxBlockersPerSearch: number;
  maxRipsPerRoute: number;
  maxTotalRips: number;
  maxSearchStates: number;
  expansionsPerStep: number;
}

export type RoutingNodeKind = "grid" | "terminal" | "fixed_via";

export interface RoutingNode extends Point {
  nodeId: string;
  layer: string;
  kind: RoutingNodeKind;
  terminalPointIds: string[];
  terminalConnectionNames: string[];
  prefabViaId?: string;
}

export type RoutingEdge =
  | {
      edgeId: number;
      key: string;
      kind: "trace";
      fromNode: number;
      toNode: number;
      cost: number;
      blockingObstacleIndexes: number[];
      conflictEdgeIds: number[];
      restrictedToConnectionName?: string;
      restrictedGuideOrder?: number;
      restrictedGuideCount?: number;
    }
  | {
      edgeId: number;
      key: string;
      kind: "fixed_via_transition";
      fromNode: number;
      toNode: number;
      cost: number;
      prefabViaId: string;
    };

export interface RoutingAdjacency {
  edgeId: number;
  toNode: number;
}

export interface RouteDemand {
  routeId: string;
  connectionName: string;
  allowedConnectionNames?: string[];
  netId: string;
  sourceNode: number;
  targetNode: number;
  sourcePointId?: string;
  targetPointId?: string;
  width: number;
}

export interface PrefabricatedVia extends Point {
  prefabViaId: string;
  obstacleIndex: number;
  layers: string[];
  width: number;
  height: number;
}

export interface PreparedBiscuitRoutingProblem {
  input: SimpleRouteJson;
  options: NormalizedBiscuitBoardAutorouterOptions;
  /** Rotated obstacles whose exact envelopes were selected automatically. */
  exactRotatedObstacleIndexes: number[];
  layers: string[];
  nodes: RoutingNode[];
  edges: RoutingEdge[];
  adjacency: RoutingAdjacency[][];
  demands: RouteDemand[];
  demandById: Map<string, RouteDemand>;
  prefabricatedVias: PrefabricatedVia[];
  fixedViaById: Map<string, PrefabricatedVia>;
}

export interface RoutedConnection {
  routeId: string;
  connectionName: string;
  netId: string;
  nodePath: number[];
  edgePath: number[];
  blockerRouteIds: string[];
}

export interface BiscuitBoardRoutingStats {
  routeCount: number;
  routedCount: number;
  pendingCount: number;
  ripCount: number;
  expandedStateCount: number;
  fixedViaTransitionCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  negotiationPassCount?: number;
  conflictRouteCount?: number;
  postProcessedClearance?: number;
  preSimplificationSegmentCount?: number;
  postSimplificationSegmentCount?: number;
  beautifiedClearance?: number;
  sameNetConsolidationCount?: number;
  fortyFiveDegreeChamferCount?: number;
}

export interface BiscuitBoardRoutingSolution {
  routes: RoutedConnection[];
  traces: SimplifiedPcbTrace[];
  stats: BiscuitBoardRoutingStats;
}

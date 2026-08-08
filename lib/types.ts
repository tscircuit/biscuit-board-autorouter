import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter";

export interface Point {
  x: number;
  y: number;
}

export interface RectBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Pipeline7Options {
  capacityDepth?: number;
  targetMinCapacity?: number;
  effort?: number;
  maxNodeDimension?: number;
  maxNodeRatio?: number;
  minNodeArea?: number;
  /** Pipeline7 port-pathing cost for an avoidable layer transition. */
  viaTransitionCost?: number;
}

export interface ViaAttractionOptions {
  /** Edge-to-edge clearance used while pushing rubber-band trace legs. */
  clearance?: number;
  /** Extra search corridor around a moving via, in millimeters. */
  detourSearchMargin?: number;
}

export interface BiscuitBoardAutorouterOptions {
  pipeline7?: Pipeline7Options;
  viaAttraction?: ViaAttractionOptions;
}

export interface PrefabricatedVia extends Point {
  obstacleIndex: number;
  layers: string[];
  width: number;
  height: number;
}

export interface ViaAssignment {
  traceIndex: number;
  viaOrdinal: number;
  connectionName: string;
  from: Point;
  target: PrefabricatedVia;
  fromLayer: string;
  toLayer: string;
}

export interface ViaAttractionStats {
  inputViaCount: number;
  movedViaCount: number;
  repelledTraceLegCount: number;
  maximumViaMovement: number;
}

export interface ViaAttractionResult {
  traces: SimplifiedPcbTrace[];
  assignments: ViaAssignment[];
  stats: ViaAttractionStats;
}

export interface BiscuitBoardRoutingSolution extends ViaAttractionResult {
  input: SimpleRouteJson;
  pipeline7Traces: SimplifiedPcbTrace[];
}

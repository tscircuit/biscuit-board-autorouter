import type { SimplifiedPcbTrace } from "@tscircuit/core";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { pointsEqual, visualizePreparedProblem } from "./geometry";
import type {
  BiscuitBoardRoutingSolution,
  PreparedBiscuitRoutingProblem,
  RoutedConnection,
} from "./types";

const sanitizeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "_");

const collapseCollinearNodes = (
  prepared: PreparedBiscuitRoutingProblem,
  nodePath: number[],
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
  const nodePath = collapseCollinearNodes(prepared, route.nodePath);
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
    const traces = this.routed.routes.map((route) =>
      routeToTrace(this.prepared, route),
    );
    assertOnlyPrefabricatedVias(this.prepared, traces);
    this.output = { ...this.routed, traces };
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

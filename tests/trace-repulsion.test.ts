import { expect, test } from "bun:test";
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter";
import { segmentDistance } from "../lib/geometry";
import { PrefabricatedViaPostprocessingSolver } from "../lib";

const input: SimpleRouteJson = {
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  layerCount: 2,
  minTraceWidth: 0.15,
  defaultObstacleMargin: 0.15,
  obstacles: [
    {
      type: "rect",
      width: 0.6,
      height: 0.6,
      center: { x: 5, y: 5 },
      layers: ["top", "bottom"],
      connectedTo: ["prefab-via"],
      netIsAssignable: true,
    },
  ],
  connections: [],
};

const traces: SimplifiedPcbTrace[] = [
  {
    type: "pcb_trace",
    pcb_trace_id: "moving",
    connection_name: "moving",
    route: [
      { route_type: "wire", x: 1, y: 1, width: 0.15, layer: "top" },
      { route_type: "wire", x: 4, y: 1, width: 0.15, layer: "top" },
      {
        route_type: "via",
        x: 4,
        y: 1,
        from_layer: "top",
        to_layer: "bottom",
      },
      { route_type: "wire", x: 4, y: 1, width: 0.15, layer: "bottom" },
      { route_type: "wire", x: 9, y: 1, width: 0.15, layer: "bottom" },
    ],
  },
  {
    type: "pcb_trace",
    pcb_trace_id: "blocker",
    connection_name: "blocker",
    route: [
      { route_type: "wire", x: 3, y: 3, width: 0.15, layer: "top" },
      { route_type: "wire", x: 7, y: 3, width: 0.15, layer: "top" },
    ],
  },
];

test("moving a via pushes its trace leg around foreign copper", () => {
  const solver = new PrefabricatedViaPostprocessingSolver({ input, traces });
  solver.solve();
  const output = solver.getOutput()!;
  const movingWires = output.traces[0]!.route.filter(
    (
      point,
    ): point is Extract<
      SimplifiedPcbTrace["route"][number],
      { route_type: "wire" }
    > => point.route_type === "wire" && point.layer === "top",
  );
  const existingCopperTransition = output.traces[0]!.route.find(
    (point) => point.route_type === "through_obstacle",
  )!;

  expect(existingCopperTransition).toMatchObject({
    start: { x: 5, y: 5 },
    end: { x: 5, y: 5 },
  });
  expect(movingWires.length).toBeGreaterThan(2);
  expect(output.stats.repelledTraceLegCount).toBeGreaterThan(0);
  for (let index = 1; index < movingWires.length; index += 1) {
    expect(
      segmentDistance(
        movingWires[index - 1]!,
        movingWires[index]!,
        { x: 3, y: 3 },
        { x: 7, y: 3 },
      ),
    ).toBeGreaterThanOrEqual(0.3 - 1e-6);
  }
});

import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter";

export const forcedPrefabricatedViaFixture: SimpleRouteJson = {
  bounds: { minX: -8, maxX: 8, minY: -3, maxY: 6 },
  layerCount: 2,
  minTraceWidth: 0.15,
  obstacles: [
    {
      obstacleId: "left-pad",
      type: "rect",
      width: 0.54,
      height: 0.64,
      center: { x: -5.5, y: 0 },
      layers: ["top"],
      componentId: "left-component",
      connectedTo: ["left-pad", "signal"],
    },
    {
      obstacleId: "right-pad",
      type: "rect",
      width: 0.54,
      height: 0.64,
      center: { x: 5.5, y: 0 },
      layers: ["bottom"],
      componentId: "right-component",
      connectedTo: ["right-pad", "signal"],
    },
    {
      obstacleId: "prefab-via-1",
      type: "rect",
      width: 0.6,
      height: 0.6,
      center: { x: 0, y: 4 },
      layers: ["top", "bottom"],
      connectedTo: ["pcb_via_prefab"],
      netIsAssignable: true,
    },
    {
      obstacleId: "center-keepout",
      type: "rect",
      width: 4,
      height: 2,
      center: { x: 0, y: 0 },
      layers: ["top", "bottom"],
      connectedTo: [],
    },
  ],
  connections: [
    {
      name: "signal",
      pointsToConnect: [
        { x: -5.5, y: 0, layer: "top", pointId: "left-pad" },
        { x: 5.5, y: 0, layer: "bottom", pointId: "right-pad" },
      ],
    },
  ],
};

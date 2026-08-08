import {
  AutoroutingPipelineSolver7_MultiGraph,
  type SimpleRouteJson,
  type SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter";
import { BaseSolver } from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import type { Pipeline7Options } from "./types";

export interface Pipeline7SolverParams {
  input: SimpleRouteJson;
  options?: Pipeline7Options;
}

const makePrefabricatedViasHardObstacles = (
  input: SimpleRouteJson,
  clearance: number,
): SimpleRouteJson => ({
  ...input,
  defaultObstacleMargin: Math.max(input.defaultObstacleMargin ?? 0, clearance),
  obstacles: input.obstacles.map((obstacle) =>
    obstacle.netIsAssignable
      ? { ...obstacle, connectedTo: [], netIsAssignable: false }
      : obstacle,
  ),
});

/** Makes Pipeline7 a standard solver-utils stage without hiding its debugger. */
export class Pipeline7Solver extends BaseSolver {
  readonly pipeline7: AutoroutingPipelineSolver7_MultiGraph;

  constructor(public readonly params: Pipeline7SolverParams) {
    super();
    const { input, options = {} } = params;
    const {
      clearance = 0.2,
      viaTransitionCost = 25,
      ...pipeline7Options
    } = options;
    this.pipeline7 = new AutoroutingPipelineSolver7_MultiGraph(
      makePrefabricatedViasHardObstacles(input, clearance),
      {
        ...pipeline7Options,
        cacheProvider: null,
      },
    );
    const portPathingStep = this.pipeline7.pipelineDef.find(
      (step) => step.solverName === "portPointPathingSolver",
    );
    if (!portPathingStep) {
      throw new Error("Pipeline7 port-point pathing stage is missing");
    }
    const getOriginalConstructorParams = portPathingStep.getConstructorParams;
    portPathingStep.getConstructorParams = (pipeline) => {
      const params = getOriginalConstructorParams(pipeline);
      const config = params[0] as {
        weights: { LAYER_CHANGE_COST: number; [key: string]: number };
        [key: string]: unknown;
      };
      return [
        {
          ...config,
          weights: {
            ...config.weights,
            LAYER_CHANGE_COST: viaTransitionCost,
          },
        },
      ] as typeof params;
    };
    this.MAX_ITERATIONS = this.pipeline7.MAX_ITERATIONS + 1;
  }

  override getConstructorParams(): [Pipeline7SolverParams] {
    return [this.params];
  }

  override _step(): void {
    this.pipeline7.step();
    this.progress = this.pipeline7.progress;
    if (this.pipeline7.failed) {
      this.failed = true;
      this.error = this.pipeline7.error ?? "Pipeline7 autorouting failed";
      return;
    }
    if (this.pipeline7.solved) this.solved = true;
  }

  override getOutput(): SimplifiedPcbTrace[] | null {
    if (!this.solved) return null;
    return this.pipeline7.getOutputSimplifiedPcbTraces();
  }

  override visualize(): GraphicsObject {
    return this.pipeline7.visualize();
  }

  override preview(): GraphicsObject {
    return this.pipeline7.preview();
  }
}

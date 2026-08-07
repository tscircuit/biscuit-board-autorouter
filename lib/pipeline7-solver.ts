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

/** Makes Pipeline7 a standard solver-utils stage without hiding its debugger. */
export class Pipeline7Solver extends BaseSolver {
  readonly pipeline7: AutoroutingPipelineSolver7_MultiGraph;

  constructor({ input, options = {} }: Pipeline7SolverParams) {
    super();
    this.pipeline7 = new AutoroutingPipelineSolver7_MultiGraph(input, {
      ...options,
      cacheProvider: null,
    });
    this.MAX_ITERATIONS = this.pipeline7.MAX_ITERATIONS + 1;
  }

  override getConstructorParams(): [Pipeline7SolverParams] {
    return [
      { input: this.pipeline7.originalSrj, options: this.pipeline7.opts },
    ];
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

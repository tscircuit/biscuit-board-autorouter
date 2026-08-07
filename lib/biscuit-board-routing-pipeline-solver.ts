import type { SimpleRouteJson } from "@tscircuit/core";
import {
  BasePipelineSolver,
  definePipelineStep,
  type PipelineStep,
} from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { BuildBiscuitBoardTracesSolver } from "./build-biscuit-board-traces-solver";
import { GenerateBiscuitBoardHypergraphSolver } from "./generate-biscuit-board-hypergraph-solver";
import { RipUpRubberBandSolver } from "./rip-up-rubber-band-solver";
import type {
  BiscuitBoardAutorouterOptions,
  BiscuitBoardRoutingSolution,
  PreparedBiscuitRoutingProblem,
} from "./types";

export class BiscuitBoardRoutingPipelineSolver extends BasePipelineSolver<SimpleRouteJson> {
  override pipelineDef: PipelineStep<any>[] = [
    definePipelineStep(
      "generate-hypergraph",
      GenerateBiscuitBoardHypergraphSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => [
        { input: instance.inputProblem, options: instance.options },
      ],
    ),
    definePipelineStep(
      "route-with-rip-and-replace",
      RipUpRubberBandSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => {
        const prepared = instance.getStageOutput<PreparedBiscuitRoutingProblem>(
          "generate-hypergraph",
        );
        if (!prepared)
          throw new Error("Hypergraph generation produced no output");
        return [prepared];
      },
    ),
    definePipelineStep(
      "build-and-validate-traces",
      BuildBiscuitBoardTracesSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => {
        const prepared = instance.getStageOutput<PreparedBiscuitRoutingProblem>(
          "generate-hypergraph",
        );
        const routed = instance.getStageOutput<BiscuitBoardRoutingSolution>(
          "route-with-rip-and-replace",
        );
        if (!prepared || !routed) {
          throw new Error("Routing pipeline stages produced no output");
        }
        return [{ prepared, routed }];
      },
    ),
  ];

  constructor(
    input: SimpleRouteJson,
    public readonly options: BiscuitBoardAutorouterOptions = {},
  ) {
    super(input);
    this.MAX_ITERATIONS = 3_000_000;
  }

  override getConstructorParams(): [
    SimpleRouteJson,
    BiscuitBoardAutorouterOptions,
  ] {
    return [this.inputProblem, this.options];
  }

  get stage() {
    return this.getCurrentStageName();
  }

  override initialVisualize(): GraphicsObject {
    return { title: "Biscuit-board routing input" };
  }

  override getOutput(): BiscuitBoardRoutingSolution | null {
    return (
      this.getStageOutput<BiscuitBoardRoutingSolution>(
        "build-and-validate-traces",
      ) ?? null
    );
  }
}

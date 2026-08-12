import type { SimpleRouteJson } from "@tscircuit/core";
import {
  BasePipelineSolver,
  definePipelineStep,
  type PipelineStep,
} from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { BeautifyBiscuitBoardTracesSolver } from "./beautify-biscuit-board-traces-solver";
import { BuildBiscuitBoardTracesSolver } from "./build-biscuit-board-traces-solver";
import { ExpandBiscuitBoardTracesSolver } from "./expand-biscuit-board-traces-solver";
import { GenerateBiscuitBoardHypergraphSolver } from "./generate-biscuit-board-hypergraph-solver";
import { PostProcessBiscuitBoardTracesSolver } from "./post-process-biscuit-board-traces-solver";
import { PruneRedundantSameNetCopperSolver } from "./prune-redundant-same-net-copper-solver";
import { RipUpRubberBandSolver } from "./rip-up-rubber-band-solver";
import { visualizeSimpleRouteJsonInput } from "./geometry";
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
    definePipelineStep(
      "post-process-traces",
      PostProcessBiscuitBoardTracesSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => {
        const prepared = instance.getStageOutput<PreparedBiscuitRoutingProblem>(
          "generate-hypergraph",
        );
        const built = instance.getStageOutput<BiscuitBoardRoutingSolution>(
          "build-and-validate-traces",
        );
        if (!prepared || !built) {
          throw new Error("Trace post-processing inputs are unavailable");
        }
        return [{ prepared, built }];
      },
    ),
    definePipelineStep(
      "beautify-traces",
      BeautifyBiscuitBoardTracesSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => {
        const prepared = instance.getStageOutput<PreparedBiscuitRoutingProblem>(
          "generate-hypergraph",
        );
        const built = instance.getStageOutput<BiscuitBoardRoutingSolution>(
          "post-process-traces",
        );
        if (!prepared || !built) {
          throw new Error("Trace beautification inputs are unavailable");
        }
        return [{ prepared, built }];
      },
    ),
    definePipelineStep(
      "prune-redundant-same-net-copper",
      PruneRedundantSameNetCopperSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => {
        const prepared = instance.getStageOutput<PreparedBiscuitRoutingProblem>(
          "generate-hypergraph",
        );
        const built =
          instance.getStageOutput<BiscuitBoardRoutingSolution>(
            "beautify-traces",
          );
        if (!prepared || !built) {
          throw new Error("Same-net topology cleanup inputs are unavailable");
        }
        return [{ prepared, built }];
      },
    ),
    definePipelineStep(
      "expand-traces",
      ExpandBiscuitBoardTracesSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => {
        const prepared = instance.getStageOutput<PreparedBiscuitRoutingProblem>(
          "generate-hypergraph",
        );
        const built = instance.getStageOutput<BiscuitBoardRoutingSolution>(
          "prune-redundant-same-net-copper",
        );
        if (!prepared || !built) {
          throw new Error("Trace expansion inputs are unavailable");
        }
        return [
          {
            prepared,
            built,
            enabled: instance.options.expandTraces,
          },
        ];
      },
    ),
  ];

  constructor(
    input: SimpleRouteJson,
    public readonly options: BiscuitBoardAutorouterOptions = {},
  ) {
    super(input);
    // The expansion stage may consume most of its eight-million-iteration
    // budget on dense boards, in addition to the graph and routing stages.
    this.MAX_ITERATIONS = 10_000_000;
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
    return visualizeSimpleRouteJsonInput(this.inputProblem);
  }

  override visualize(): GraphicsObject {
    if (this.solved) {
      return this.getSolver("expand-traces")?.visualize() ?? super.visualize();
    }
    return super.visualize();
  }

  override getOutput(): BiscuitBoardRoutingSolution | null {
    return (
      this.getStageOutput<BiscuitBoardRoutingSolution>("expand-traces") ?? null
    );
  }
}

import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter";
import {
  BasePipelineSolver,
  definePipelineStep,
  type PipelineStep,
} from "@tscircuit/solver-utils";
import type { GraphicsObject } from "graphics-debug";
import { Pipeline7Solver } from "./pipeline7-solver";
import { PrefabricatedViaPostprocessingSolver } from "./prefabricated-via-postprocessing-solver";
import type {
  BiscuitBoardAutorouterOptions,
  BiscuitBoardRoutingSolution,
  ViaAttractionResult,
} from "./types";

export class BiscuitBoardRoutingPipelineSolver extends BasePipelineSolver<SimpleRouteJson> {
  override pipelineDef: PipelineStep<any>[] = [
    definePipelineStep(
      "pipeline7",
      Pipeline7Solver,
      (instance: BiscuitBoardRoutingPipelineSolver) => [
        {
          input: instance.inputProblem,
          options: instance.options.pipeline7,
        },
      ],
    ),
    definePipelineStep(
      "prefabricated-via-attraction",
      PrefabricatedViaPostprocessingSolver,
      (instance: BiscuitBoardRoutingPipelineSolver) => {
        const traces =
          instance.getStageOutput<SimplifiedPcbTrace[]>("pipeline7");
        if (!traces) throw new Error("Pipeline7 produced no routed traces");
        return [
          {
            input: instance.inputProblem,
            traces,
            options: instance.options.viaAttraction,
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
    this.MAX_ITERATIONS = 100_000_001;
  }

  override getConstructorParams(): [
    SimpleRouteJson,
    BiscuitBoardAutorouterOptions,
  ] {
    return [this.inputProblem, this.options];
  }

  get stage(): string {
    return this.getCurrentStageName();
  }

  override initialVisualize(): GraphicsObject {
    return { title: "Biscuit-board Simple Route JSON input" };
  }

  override getOutput(): BiscuitBoardRoutingSolution | null {
    const pipeline7Traces =
      this.getStageOutput<SimplifiedPcbTrace[]>("pipeline7");
    const postprocessed = this.getStageOutput<ViaAttractionResult>(
      "prefabricated-via-attraction",
    );
    if (!pipeline7Traces || !postprocessed) return null;
    return {
      input: this.inputProblem,
      pipeline7Traces,
      ...postprocessed,
    };
  }
}

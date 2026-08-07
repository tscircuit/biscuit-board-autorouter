import type {
  AutorouterCompleteEvent,
  AutorouterErrorEvent,
  AutorouterProgressEvent,
  GenericLocalAutorouter,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/core";
import type { AutorouterConfig } from "@tscircuit/props";
import { BiscuitBoardRoutingPipelineSolver } from "./biscuit-board-routing-pipeline-solver";
import type { BiscuitBoardAutorouterOptions } from "./types";

type EventHandlers = {
  complete: Array<(event: AutorouterCompleteEvent) => void>;
  error: Array<(event: AutorouterErrorEvent) => void>;
  progress: Array<(event: AutorouterProgressEvent) => void>;
};

export class BiscuitBoardAutorouter implements GenericLocalAutorouter {
  isRouting = false;
  readonly solver: BiscuitBoardRoutingPipelineSolver;
  private traces?: SimplifiedPcbTrace[];
  private readonly handlers: EventHandlers = {
    complete: [],
    error: [],
    progress: [],
  };

  constructor(
    public readonly input: SimpleRouteJson,
    options: BiscuitBoardAutorouterOptions = {},
  ) {
    this.solver = new BiscuitBoardRoutingPipelineSolver(input, options);
  }

  solveSync(): SimplifiedPcbTrace[] {
    if (this.traces) return this.traces;
    this.solver.solve();
    if (this.solver.failed) {
      throw new Error(this.solver.error ?? "Biscuit-board autorouting failed");
    }
    const output = this.solver.getOutput();
    if (!output) throw new Error("Biscuit-board autorouter produced no output");
    this.traces = output.traces;
    return this.traces;
  }

  getOutputSimpleRouteJson(): SimpleRouteJson | undefined {
    if (!this.traces) return undefined;
    return { ...this.input, traces: this.traces };
  }

  start(): void {
    if (this.isRouting) return;
    this.isRouting = true;
    queueMicrotask(() => {
      if (!this.isRouting) return;
      try {
        const traces = this.solveSync();
        for (const handler of this.handlers.complete) {
          handler({ type: "complete", traces });
        }
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        for (const handler of this.handlers.error) {
          handler({ type: "error", error });
        }
      } finally {
        this.isRouting = false;
      }
    });
  }

  stop(): void {
    this.isRouting = false;
  }

  on(
    event: "complete",
    callback: (event: AutorouterCompleteEvent) => void,
  ): void;
  on(event: "error", callback: (event: AutorouterErrorEvent) => void): void;
  on(
    event: "progress",
    callback: (event: AutorouterProgressEvent) => void,
  ): void;
  on(
    event: "complete" | "error" | "progress",
    callback:
      | ((event: AutorouterCompleteEvent) => void)
      | ((event: AutorouterErrorEvent) => void)
      | ((event: AutorouterProgressEvent) => void),
  ): void {
    if (event === "complete") {
      this.handlers.complete.push(
        callback as (event: AutorouterCompleteEvent) => void,
      );
    } else if (event === "error") {
      this.handlers.error.push(
        callback as (event: AutorouterErrorEvent) => void,
      );
    } else {
      this.handlers.progress.push(
        callback as (event: AutorouterProgressEvent) => void,
      );
    }
  }
}

export const createBiscuitBoardAutorouter = (
  options: BiscuitBoardAutorouterOptions = {},
): AutorouterConfig => ({
  local: true,
  groupMode: "subcircuit",
  algorithmFn: async (input: SimpleRouteJson) =>
    new BiscuitBoardAutorouter(input, options),
});

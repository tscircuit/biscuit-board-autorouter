import { parentPort } from "node:worker_threads";
import type { SimpleRouteJson } from "@tscircuit/core";
import { BiscuitBoardAutorouter } from "./biscuit-board-autorouter";
import type { BiscuitBoardAutorouterOptions } from "./types";

interface WorkerRequest {
  id: number;
  input: SimpleRouteJson;
  options: BiscuitBoardAutorouterOptions;
}

const workerPort = parentPort;
if (!workerPort) throw new Error("Biscuit-board worker requires a parent port");

workerPort.on("message", ({ id, input, options }: WorkerRequest) => {
  try {
    const traces = new BiscuitBoardAutorouter(input, options).solveSync();
    workerPort.postMessage({ id, traces });
  } catch (cause) {
    workerPort.postMessage({
      id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
});

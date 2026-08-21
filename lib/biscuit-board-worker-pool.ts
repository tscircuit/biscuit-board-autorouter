import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";
import type { BiscuitBoardAutorouterOptions } from "./types";

interface QueuedRoute {
  id: number;
  input: SimpleRouteJson;
  options: BiscuitBoardAutorouterOptions;
  resolve: (traces: SimplifiedPcbTrace[]) => void;
  reject: (error: Error) => void;
}

interface WorkerResponse {
  id: number;
  traces?: SimplifiedPcbTrace[];
  error?: string;
}

export interface BiscuitBoardWorkerPoolOptions {
  size?: number;
}

export class BiscuitBoardWorkerPool {
  readonly size: number;
  private readonly workers = new Set<Worker>();
  private readonly idleWorkers: Worker[] = [];
  private readonly activeTaskByWorker = new Map<Worker, QueuedRoute>();
  private readonly queue: QueuedRoute[] = [];
  private nextTaskId = 1;
  private closed = false;

  constructor(options: BiscuitBoardWorkerPoolOptions = {}) {
    const requestedSize =
      options.size ?? Math.max(1, Math.min(4, availableParallelism() - 1));
    if (!Number.isInteger(requestedSize) || requestedSize <= 0) {
      throw new Error("worker pool size must be a positive integer");
    }
    this.size = requestedSize;
    for (let index = 0; index < this.size; index++) this.spawnWorker();
  }

  route(
    input: SimpleRouteJson,
    options: BiscuitBoardAutorouterOptions = {},
  ): Promise<SimplifiedPcbTrace[]> {
    if (this.closed) return Promise.reject(new Error("worker pool is closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextTaskId++,
        input,
        options,
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  routeMany(
    inputs: SimpleRouteJson[],
    options: BiscuitBoardAutorouterOptions = {},
  ) {
    return Promise.all(inputs.map((input) => this.route(input, options)));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("worker pool closed before routing completed");
    for (const task of this.queue.splice(0)) task.reject(error);
    for (const task of this.activeTaskByWorker.values()) task.reject(error);
    this.activeTaskByWorker.clear();
    await Promise.all(Array.from(this.workers, (worker) => worker.terminate()));
    this.workers.clear();
    this.idleWorkers.length = 0;
  }

  private spawnWorker() {
    const worker = new Worker(
      new URL("./biscuit-board-worker.ts", import.meta.url),
    );
    this.workers.add(worker);
    this.idleWorkers.push(worker);
    worker.on("message", (response: WorkerResponse) => {
      const task = this.activeTaskByWorker.get(worker);
      if (!task || task.id !== response.id) return;
      this.activeTaskByWorker.delete(worker);
      if (response.error) task.reject(new Error(response.error));
      else if (response.traces) task.resolve(response.traces);
      else task.reject(new Error("worker returned no routing result"));
      if (!this.closed) this.idleWorkers.push(worker);
      this.dispatch();
    });
    worker.on("error", (cause) =>
      this.handleWorkerFailure(
        worker,
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
    worker.on("exit", (code) => {
      if (!this.closed) {
        this.handleWorkerFailure(
          worker,
          new Error(`routing worker exited with code ${code}`),
        );
      }
    });
  }

  private handleWorkerFailure(worker: Worker, cause: Error) {
    if (!this.workers.delete(worker)) return;
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) this.idleWorkers.splice(idleIndex, 1);
    const task = this.activeTaskByWorker.get(worker);
    if (task) {
      this.activeTaskByWorker.delete(worker);
      task.reject(cause);
    }
    if (!this.closed) {
      this.spawnWorker();
      this.dispatch();
    }
  }

  private dispatch() {
    while (
      !this.closed &&
      this.queue.length > 0 &&
      this.idleWorkers.length > 0
    ) {
      const worker = this.idleWorkers.pop();
      const task = this.queue.shift();
      if (!worker || !task) break;
      this.activeTaskByWorker.set(worker, task);
      worker.postMessage({
        id: task.id,
        input: task.input,
        options: task.options,
      });
    }
  }
}

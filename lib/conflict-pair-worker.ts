import {
  collectPackedConflictRange,
  type ConflictRangeResult,
  type PackedConflictIndex,
} from "./conflict-pair-collector";
import { workerData } from "node:worker_threads";

const data = workerData as {
  packed: PackedConflictIndex;
  minimumTraceCenterDistance: number;
  startTraceIndex: number;
  endTraceIndex: number;
  port: import("node:worker_threads").MessagePort;
  status: Int32Array;
};

try {
  const result: ConflictRangeResult = collectPackedConflictRange(
    data.packed,
    data.minimumTraceCenterDistance,
    data.startTraceIndex,
    data.endTraceIndex,
  );
  data.port.postMessage(
    { result },
    result.chunks.map((chunk) => chunk.buffer as ArrayBuffer),
  );
} catch (error) {
  data.port.postMessage({
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
} finally {
  Atomics.store(data.status, 0, 1);
  Atomics.notify(data.status, 0);
  data.port.close();
}

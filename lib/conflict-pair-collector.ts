import type { RoutingEdge, RoutingNode } from "./types";

const BUCKET_SIZE = 2;
const PAIR_CHUNK_VALUES = 1 << 20;
const PARALLEL_EDGE_THRESHOLD = 100_000;
const MAX_AUTOMATIC_WORKERS = 4;
const WORKER_WAIT_TIMEOUT_MS = 120_000;
const EPSILON = 1e-7;

export interface PackedConflictIndex {
  edgeIds: Uint32Array;
  layers: Uint16Array;
  coordinates: Float64Array;
  bounds: Float64Array;
  cellBounds: Int32Array;
  bucketOffsets: Uint32Array;
  bucketEntries: Uint32Array;
  minimumCellX: number;
  minimumCellY: number;
  cellWidth: number;
  cellHeight: number;
  layerCount: number;
}

export interface ConflictRangeResult {
  chunks: Uint32Array[];
  valueCount: number;
  candidateVisitCount: number;
  uniqueCandidateCount: number;
  distanceCheckCount: number;
}

export interface ConflictCollectionResult {
  pairs: ConflictPairCollection;
  candidateVisitCount: number;
  uniqueCandidateCount: number;
  distanceCheckCount: number;
  bucketEntryCount: number;
  workerCount: number;
}

export class ConflictPairCollection {
  private readonly parts: Array<{
    chunks: Uint32Array[];
    valueCount: number;
  }> = [];

  append(chunks: Uint32Array[], valueCount: number) {
    if (valueCount > 0) this.parts.push({ chunks, valueCount });
  }

  forEach(visit: (firstEdgeId: number, secondEdgeId: number) => void) {
    for (const part of this.parts) {
      let remaining = part.valueCount;
      let firstEdgeId: number | undefined;
      for (const chunk of part.chunks) {
        const length = Math.min(remaining, chunk.length);
        for (let index = 0; index < length; index++) {
          const value = chunk[index]!;
          if (firstEdgeId === undefined) firstEdgeId = value;
          else {
            visit(firstEdgeId, value);
            firstEdgeId = undefined;
          }
        }
        remaining -= length;
        if (remaining === 0) break;
      }
    }
  }
}

const createUint32Array = (length: number, shared: boolean) =>
  new Uint32Array(
    shared
      ? new SharedArrayBuffer(length * Uint32Array.BYTES_PER_ELEMENT)
      : new ArrayBuffer(length * Uint32Array.BYTES_PER_ELEMENT),
  );

const createUint16Array = (length: number, shared: boolean) =>
  new Uint16Array(
    shared
      ? new SharedArrayBuffer(length * Uint16Array.BYTES_PER_ELEMENT)
      : new ArrayBuffer(length * Uint16Array.BYTES_PER_ELEMENT),
  );

const createInt32Array = (length: number, shared: boolean) =>
  new Int32Array(
    shared
      ? new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT)
      : new ArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT),
  );

const createFloat64Array = (length: number, shared: boolean) =>
  new Float64Array(
    shared
      ? new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT)
      : new ArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
  );

const getBucketIndex = (
  packed: Pick<
    PackedConflictIndex,
    "minimumCellX" | "minimumCellY" | "cellWidth" | "cellHeight"
  >,
  layer: number,
  cellX: number,
  cellY: number,
) =>
  (layer * packed.cellWidth + cellX - packed.minimumCellX) * packed.cellHeight +
  cellY -
  packed.minimumCellY;

const buildPackedConflictIndex = (
  traceEdges: Array<Extract<RoutingEdge, { kind: "trace" }>>,
  nodes: RoutingNode[],
  shared: boolean,
): PackedConflictIndex => {
  const traceCount = traceEdges.length;
  const edgeIds = createUint32Array(traceCount, shared);
  const layers = createUint16Array(traceCount, shared);
  const coordinates = createFloat64Array(traceCount * 4, shared);
  const bounds = createFloat64Array(traceCount * 4, shared);
  const cellBounds = createInt32Array(traceCount * 4, shared);
  const layerIndexByName = new Map<string, number>();
  let minimumCellX = Number.POSITIVE_INFINITY;
  let maximumCellX = Number.NEGATIVE_INFINITY;
  let minimumCellY = Number.POSITIVE_INFINITY;
  let maximumCellY = Number.NEGATIVE_INFINITY;

  for (let traceIndex = 0; traceIndex < traceCount; traceIndex++) {
    const edge = traceEdges[traceIndex]!;
    const from = nodes[edge.fromNode]!;
    const to = nodes[edge.toNode]!;
    let layerIndex = layerIndexByName.get(from.layer);
    if (layerIndex === undefined) {
      layerIndex = layerIndexByName.size;
      layerIndexByName.set(from.layer, layerIndex);
    }
    const coordinateOffset = traceIndex * 4;
    const minimumX = Math.min(from.x, to.x);
    const maximumX = Math.max(from.x, to.x);
    const minimumY = Math.min(from.y, to.y);
    const maximumY = Math.max(from.y, to.y);
    const minimumBucketX = Math.floor(minimumX / BUCKET_SIZE);
    const maximumBucketX = Math.floor(maximumX / BUCKET_SIZE);
    const minimumBucketY = Math.floor(minimumY / BUCKET_SIZE);
    const maximumBucketY = Math.floor(maximumY / BUCKET_SIZE);
    edgeIds[traceIndex] = edge.edgeId;
    layers[traceIndex] = layerIndex;
    coordinates[coordinateOffset] = from.x;
    coordinates[coordinateOffset + 1] = from.y;
    coordinates[coordinateOffset + 2] = to.x;
    coordinates[coordinateOffset + 3] = to.y;
    bounds[coordinateOffset] = minimumX;
    bounds[coordinateOffset + 1] = maximumX;
    bounds[coordinateOffset + 2] = minimumY;
    bounds[coordinateOffset + 3] = maximumY;
    cellBounds[coordinateOffset] = minimumBucketX;
    cellBounds[coordinateOffset + 1] = maximumBucketX;
    cellBounds[coordinateOffset + 2] = minimumBucketY;
    cellBounds[coordinateOffset + 3] = maximumBucketY;
    minimumCellX = Math.min(minimumCellX, minimumBucketX);
    maximumCellX = Math.max(maximumCellX, maximumBucketX);
    minimumCellY = Math.min(minimumCellY, minimumBucketY);
    maximumCellY = Math.max(maximumCellY, maximumBucketY);
  }

  if (traceCount === 0) {
    minimumCellX = 0;
    maximumCellX = 0;
    minimumCellY = 0;
    maximumCellY = 0;
  }
  const cellWidth = maximumCellX - minimumCellX + 1;
  const cellHeight = maximumCellY - minimumCellY + 1;
  const bucketCount = layerIndexByName.size * cellWidth * cellHeight;
  const bucketCounts = new Uint32Array(bucketCount);
  const dimensions = {
    minimumCellX,
    minimumCellY,
    cellWidth,
    cellHeight,
  };
  let bucketEntryCount = 0;
  for (let traceIndex = 0; traceIndex < traceCount; traceIndex++) {
    const offset = traceIndex * 4;
    const layer = layers[traceIndex]!;
    for (
      let cellX = cellBounds[offset]!;
      cellX <= cellBounds[offset + 1]!;
      cellX++
    ) {
      for (
        let cellY = cellBounds[offset + 2]!;
        cellY <= cellBounds[offset + 3]!;
        cellY++
      ) {
        bucketCounts[getBucketIndex(dimensions, layer, cellX, cellY)]!++;
        bucketEntryCount++;
      }
    }
  }
  const bucketOffsets = createUint32Array(bucketCount + 1, shared);
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
    bucketOffsets[bucketIndex + 1] =
      bucketOffsets[bucketIndex]! + bucketCounts[bucketIndex]!;
  }
  const bucketEntries = createUint32Array(bucketEntryCount, shared);
  const writeOffsets = bucketOffsets.slice(0, bucketCount);
  for (let traceIndex = 0; traceIndex < traceCount; traceIndex++) {
    const offset = traceIndex * 4;
    const layer = layers[traceIndex]!;
    for (
      let cellX = cellBounds[offset]!;
      cellX <= cellBounds[offset + 1]!;
      cellX++
    ) {
      for (
        let cellY = cellBounds[offset + 2]!;
        cellY <= cellBounds[offset + 3]!;
        cellY++
      ) {
        const bucketIndex = getBucketIndex(dimensions, layer, cellX, cellY);
        bucketEntries[writeOffsets[bucketIndex]!] = traceIndex;
        writeOffsets[bucketIndex]!++;
      }
    }
  }
  return {
    edgeIds,
    layers,
    coordinates,
    bounds,
    cellBounds,
    bucketOffsets,
    bucketEntries,
    minimumCellX,
    minimumCellY,
    cellWidth,
    cellHeight,
    layerCount: layerIndexByName.size,
  };
};

const cross = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

const onSegment = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
) =>
  Math.abs(cross(ax, ay, bx, by, px, py)) <= EPSILON &&
  px >= Math.min(ax, bx) - EPSILON &&
  px <= Math.max(ax, bx) + EPSILON &&
  py >= Math.min(ay, by) - EPSILON &&
  py <= Math.max(ay, by) + EPSILON;

const segmentsIntersect = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
) => {
  const first = cross(ax, ay, bx, by, cx, cy);
  const second = cross(ax, ay, bx, by, dx, dy);
  const third = cross(cx, cy, dx, dy, ax, ay);
  const fourth = cross(cx, cy, dx, dy, bx, by);
  if (
    ((first > EPSILON && second < -EPSILON) ||
      (first < -EPSILON && second > EPSILON)) &&
    ((third > EPSILON && fourth < -EPSILON) ||
      (third < -EPSILON && fourth > EPSILON))
  ) {
    return true;
  }
  return (
    onSegment(ax, ay, bx, by, cx, cy) ||
    onSegment(ax, ay, bx, by, dx, dy) ||
    onSegment(cx, cy, dx, dy, ax, ay) ||
    onSegment(cx, cy, dx, dy, bx, by)
  );
};

const pointToSegmentDistance = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const deltaX = bx - ax;
  const deltaY = by - ay;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= EPSILON) return Math.hypot(px - ax, py - ay);
  const ratio = Math.max(
    0,
    Math.min(1, ((px - ax) * deltaX + (py - ay) * deltaY) / lengthSquared),
  );
  return Math.hypot(px - (ax + ratio * deltaX), py - (ay + ratio * deltaY));
};

const segmentDistance = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
) => {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointToSegmentDistance(ax, ay, cx, cy, dx, dy),
    pointToSegmentDistance(bx, by, cx, cy, dx, dy),
    pointToSegmentDistance(cx, cy, ax, ay, bx, by),
    pointToSegmentDistance(dx, dy, ax, ay, bx, by),
  );
};

export const collectPackedConflictRange = (
  packed: PackedConflictIndex,
  minimumTraceCenterDistance: number,
  startTraceIndex: number,
  endTraceIndex: number,
): ConflictRangeResult => {
  const chunks: Uint32Array[] = [];
  let activeChunk = new Uint32Array(PAIR_CHUNK_VALUES);
  chunks.push(activeChunk);
  let valueCount = 0;
  let candidateVisitCount = 0;
  let uniqueCandidateCount = 0;
  let distanceCheckCount = 0;
  const maximumCellX = packed.minimumCellX + packed.cellWidth - 1;
  const maximumCellY = packed.minimumCellY + packed.cellHeight - 1;
  const conflictThreshold = minimumTraceCenterDistance - EPSILON;
  const push = (value: number) => {
    const chunkOffset = valueCount & (PAIR_CHUNK_VALUES - 1);
    if (chunkOffset === 0 && valueCount > 0) {
      activeChunk = new Uint32Array(PAIR_CHUNK_VALUES);
      chunks.push(activeChunk);
    }
    activeChunk[chunkOffset] = value;
    valueCount++;
  };

  for (
    let traceIndex = startTraceIndex;
    traceIndex < endTraceIndex;
    traceIndex++
  ) {
    const offset = traceIndex * 4;
    const edgeMinimumX = packed.bounds[offset]! - minimumTraceCenterDistance;
    const edgeMaximumX =
      packed.bounds[offset + 1]! + minimumTraceCenterDistance;
    const edgeMinimumY =
      packed.bounds[offset + 2]! - minimumTraceCenterDistance;
    const edgeMaximumY =
      packed.bounds[offset + 3]! + minimumTraceCenterDistance;
    const minimumBucketX = Math.max(
      packed.minimumCellX,
      Math.floor(edgeMinimumX / BUCKET_SIZE),
    );
    const maximumBucketX = Math.min(
      maximumCellX,
      Math.floor(edgeMaximumX / BUCKET_SIZE),
    );
    const minimumBucketY = Math.max(
      packed.minimumCellY,
      Math.floor(edgeMinimumY / BUCKET_SIZE),
    );
    const maximumBucketY = Math.min(
      maximumCellY,
      Math.floor(edgeMaximumY / BUCKET_SIZE),
    );
    const layer = packed.layers[traceIndex]!;
    for (let cellX = minimumBucketX; cellX <= maximumBucketX; cellX++) {
      for (let cellY = minimumBucketY; cellY <= maximumBucketY; cellY++) {
        const bucketIndex = getBucketIndex(packed, layer, cellX, cellY);
        const bucketEnd = packed.bucketOffsets[bucketIndex + 1]!;
        for (
          let entryOffset = packed.bucketOffsets[bucketIndex]!;
          entryOffset < bucketEnd;
          entryOffset++
        ) {
          const candidateIndex = packed.bucketEntries[entryOffset]!;
          if (candidateIndex >= traceIndex) break;
          candidateVisitCount++;
          const candidateOffset = candidateIndex * 4;
          // A pair is considered only in the first bucket shared by the
          // expanded query and the candidate's actual bounds. This preserves
          // discovery order while eliminating per-edge de-duplication state.
          if (
            cellX !==
              Math.max(minimumBucketX, packed.cellBounds[candidateOffset]!) ||
            cellY !==
              Math.max(minimumBucketY, packed.cellBounds[candidateOffset + 2]!)
          ) {
            continue;
          }
          uniqueCandidateCount++;
          if (
            packed.bounds[candidateOffset]! > edgeMaximumX ||
            packed.bounds[candidateOffset + 1]! < edgeMinimumX ||
            packed.bounds[candidateOffset + 2]! > edgeMaximumY ||
            packed.bounds[candidateOffset + 3]! < edgeMinimumY
          ) {
            continue;
          }
          distanceCheckCount++;
          if (
            segmentDistance(
              packed.coordinates[offset]!,
              packed.coordinates[offset + 1]!,
              packed.coordinates[offset + 2]!,
              packed.coordinates[offset + 3]!,
              packed.coordinates[candidateOffset]!,
              packed.coordinates[candidateOffset + 1]!,
              packed.coordinates[candidateOffset + 2]!,
              packed.coordinates[candidateOffset + 3]!,
            ) < conflictThreshold
          ) {
            push(packed.edgeIds[traceIndex]!);
            push(packed.edgeIds[candidateIndex]!);
          }
        }
      }
    }
  }
  return {
    chunks: valueCount === 0 ? [] : chunks,
    valueCount,
    candidateVisitCount,
    uniqueCandidateCount,
    distanceCheckCount,
  };
};

type WorkerThreadsModule = typeof import("node:worker_threads");
type OsModule = typeof import("node:os");

const getBuiltinModule = (name: string) => {
  if (typeof process === "undefined") return undefined;
  const getter = (
    process as unknown as {
      getBuiltinModule?: (moduleName: string) => unknown;
    }
  ).getBuiltinModule;
  return getter?.(name);
};

const getWorkerCount = (traceCount: number, requestedWorkerCount: number) => {
  if (
    requestedWorkerCount === 1 ||
    (requestedWorkerCount === 0 && traceCount < PARALLEL_EDGE_THRESHOLD)
  ) {
    return 1;
  }
  const workerThreads = getBuiltinModule("node:worker_threads") as
    | WorkerThreadsModule
    | undefined;
  if (!workerThreads?.isMainThread) return 1;
  const os = getBuiltinModule("node:os") as OsModule | undefined;
  const available = os?.availableParallelism?.() ?? 1;
  const maximum =
    requestedWorkerCount > 1
      ? requestedWorkerCount
      : Math.min(MAX_AUTOMATIC_WORKERS, Math.max(1, available - 1));
  const usefulWorkerCount =
    requestedWorkerCount > 1
      ? traceCount
      : Math.max(1, Math.ceil(traceCount / 30_000));
  return Math.max(1, Math.min(maximum, usefulWorkerCount));
};

const collectWithWorkers = (
  packed: PackedConflictIndex,
  minimumTraceCenterDistance: number,
  workerCount: number,
) => {
  const workerThreads = getBuiltinModule(
    "node:worker_threads",
  ) as WorkerThreadsModule;
  const workers: import("node:worker_threads").Worker[] = [];
  const ports: import("node:worker_threads").MessagePort[] = [];
  const statuses: Int32Array[] = [];
  const traceCount = packed.edgeIds.length;
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    // Later edges can see more prior candidates. Square-root boundaries
    // approximate equal pair work instead of equal edge counts.
    const startTraceIndex = Math.floor(
      traceCount * Math.sqrt(workerIndex / workerCount),
    );
    const endTraceIndex = Math.floor(
      traceCount * Math.sqrt((workerIndex + 1) / workerCount),
    );
    const { port1, port2 } = new workerThreads.MessageChannel();
    const status = new Int32Array(new SharedArrayBuffer(4));
    const worker = new workerThreads.Worker(
      new URL("./conflict-pair-worker.ts", import.meta.url),
      {
        workerData: {
          packed,
          minimumTraceCenterDistance,
          startTraceIndex,
          endTraceIndex,
          port: port2,
          status,
        },
        transferList: [port2],
      },
    );
    workers.push(worker);
    ports.push(port1);
    statuses.push(status);
  }

  const results: ConflictRangeResult[] = [];
  try {
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
      const status = statuses[workerIndex]!;
      if (Atomics.wait(status, 0, 0, WORKER_WAIT_TIMEOUT_MS) === "timed-out") {
        throw new Error(`Conflict worker ${workerIndex} timed out`);
      }
      let message = workerThreads.receiveMessageOnPort(ports[workerIndex]!);
      while (!message) {
        Atomics.wait(status, 0, 1, 1);
        message = workerThreads.receiveMessageOnPort(ports[workerIndex]!);
      }
      const payload = message.message as
        | { result: ConflictRangeResult }
        | { error: string };
      if ("error" in payload) throw new Error(payload.error);
      results.push(payload.result);
    }
  } finally {
    for (const port of ports) port.close();
    for (const worker of workers) void worker.terminate();
  }
  return results;
};

export const collectRoutingEdgeConflicts = (
  edges: RoutingEdge[],
  nodes: RoutingNode[],
  minimumTraceCenterDistance: number,
  requestedWorkerCount: number,
): ConflictCollectionResult => {
  const traceEdges = edges.filter(
    (edge): edge is Extract<RoutingEdge, { kind: "trace" }> =>
      edge.kind === "trace",
  );
  const workerCount = getWorkerCount(traceEdges.length, requestedWorkerCount);
  const packed = buildPackedConflictIndex(traceEdges, nodes, workerCount > 1);
  const rangeResults =
    workerCount > 1
      ? collectWithWorkers(packed, minimumTraceCenterDistance, workerCount)
      : [
          collectPackedConflictRange(
            packed,
            minimumTraceCenterDistance,
            0,
            traceEdges.length,
          ),
        ];
  const pairs = new ConflictPairCollection();
  let candidateVisitCount = 0;
  let uniqueCandidateCount = 0;
  let distanceCheckCount = 0;
  for (const result of rangeResults) {
    pairs.append(result.chunks, result.valueCount);
    candidateVisitCount += result.candidateVisitCount;
    uniqueCandidateCount += result.uniqueCandidateCount;
    distanceCheckCount += result.distanceCheckCount;
  }
  return {
    pairs,
    candidateVisitCount,
    uniqueCandidateCount,
    distanceCheckCount,
    bucketEntryCount: packed.bucketEntries.length,
    workerCount,
  };
};

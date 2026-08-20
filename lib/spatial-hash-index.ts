import type { RectBounds } from "./types";

interface SpatialEntry<T> {
  bounds: RectBounds;
  value: T;
}

/** Static uniform-grid index with allocation-free, duplicate-free queries. */
export class SpatialHashIndex<T> {
  private readonly entries: SpatialEntry<T>[] = [];
  private readonly buckets = new Map<string, number[]>();
  private readonly seenGenerationByEntry: number[] = [];
  private queryGeneration = 0;

  constructor(private readonly cellSize: number) {}

  add(bounds: RectBounds, value: T) {
    const entryId = this.entries.length;
    this.entries.push({ bounds, value });
    const minCellX = Math.floor(bounds.minX / this.cellSize);
    const maxCellX = Math.floor(bounds.maxX / this.cellSize);
    const minCellY = Math.floor(bounds.minY / this.cellSize);
    const maxCellY = Math.floor(bounds.maxY / this.cellSize);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = `${cellX}:${cellY}`;
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(entryId);
        else this.buckets.set(key, [entryId]);
      }
    }
  }

  /** Stops early when visit returns false. */
  forEach(bounds: RectBounds, visit: (value: T) => boolean | void) {
    const generation = ++this.queryGeneration;
    const minCellX = Math.floor(bounds.minX / this.cellSize);
    const maxCellX = Math.floor(bounds.maxX / this.cellSize);
    const minCellY = Math.floor(bounds.minY / this.cellSize);
    const maxCellY = Math.floor(bounds.maxY / this.cellSize);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.buckets.get(`${cellX}:${cellY}`);
        if (!bucket) continue;
        for (const entryId of bucket) {
          if (this.seenGenerationByEntry[entryId] === generation) continue;
          this.seenGenerationByEntry[entryId] = generation;
          const entry = this.entries[entryId]!;
          if (
            entry.bounds.maxX < bounds.minX ||
            entry.bounds.minX > bounds.maxX ||
            entry.bounds.maxY < bounds.minY ||
            entry.bounds.minY > bounds.maxY
          ) {
            continue;
          }
          if (visit(entry.value) === false) return false;
        }
      }
    }
    return true;
  }
}

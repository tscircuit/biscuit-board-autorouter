import { expect, test } from "bun:test";
import { MinHeap } from "../lib/min-heap";

test("trims a heap to its lowest-priority entries", () => {
  const heap = new MinHeap<string>();
  heap.push(8, "eight");
  heap.push(2, "two");
  heap.push(5, "five");
  heap.push(1, "one");

  expect(heap.trimToSize(2)).toBe(2);
  expect(heap.size).toBe(2);
  expect(heap.pop()).toBe("one");
  expect(heap.pop()).toBe("two");
  expect(heap.pop()).toBeUndefined();
});

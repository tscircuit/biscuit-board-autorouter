export class MinHeap<T> {
  private values: T[] = [];
  private priorities: number[] = [];

  get size() {
    return this.values.length;
  }

  push(priority: number, value: T) {
    this.values.push(value);
    this.priorities.push(priority);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.priorities[parent]! <= priority) break;
      this.values[index] = this.values[parent]!;
      this.priorities[index] = this.priorities[parent]!;
      index = parent;
    }
    this.values[index] = value;
    this.priorities[index] = priority;
  }

  trimToSize(maxSize: number) {
    if (this.values.length <= maxSize) return 0;
    const previousSize = this.values.length;
    const entries = this.values.map((value, index) => ({
      value,
      priority: this.priorities[index]!,
      index,
    }));
    entries.sort(
      (left, right) =>
        left.priority - right.priority || left.index - right.index,
    );
    this.values = entries.slice(0, maxSize).map(({ value }) => value);
    this.priorities = entries.slice(0, maxSize).map(({ priority }) => priority);
    return previousSize - maxSize;
  }

  pop(): T | undefined {
    if (this.values.length === 0) return undefined;
    const root = this.values[0]!;
    const lastValue = this.values.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.values.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child =
        right < this.values.length &&
        this.priorities[right]! < this.priorities[left]!
          ? right
          : left;
      if (this.priorities[child]! >= lastPriority) break;
      this.values[index] = this.values[child]!;
      this.priorities[index] = this.priorities[child]!;
      index = child;
    }
    this.values[index] = lastValue;
    this.priorities[index] = lastPriority;
    return root;
  }
}

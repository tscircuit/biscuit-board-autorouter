export class MinHeap<T> {
  private values: Array<{ priority: number; value: T }> = [];

  get size() {
    return this.values.length;
  }

  push(priority: number, value: T) {
    const entry = { priority, value };
    this.values.push(entry);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.priority <= priority) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = entry;
  }

  pop(): T | undefined {
    if (this.values.length === 0) return undefined;
    const root = this.values[0]!.value;
    const last = this.values.pop()!;
    if (this.values.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child =
        right < this.values.length &&
        this.values[right]!.priority < this.values[left]!.priority
          ? right
          : left;
      if (this.values[child]!.priority >= last.priority) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return root;
  }
}

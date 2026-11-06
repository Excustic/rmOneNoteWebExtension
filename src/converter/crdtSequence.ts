/**
 * Ordered CRDT sequence container and deterministic Kahn topological sorter.
 *
 * Matches `ricklupton/rmscene` (`crdt_sequence.py`): concurrent inserts at the
 * same position break ties by placing higher `part1` (author ID) first, then
 * lower `part2` (sequence counter).
 */

import { type CrdtId, crdtIdEquals, crdtIdKey, END_MARKER } from './binaryReader';

export interface CrdtSequenceItem<T> {
  readonly itemId: CrdtId;
  readonly leftId: CrdtId;
  readonly rightId: CrdtId;
  readonly deletedLength: number;
  readonly value: T;
}

const START_NODE = '__start';
const END_NODE = '__end';

interface HeapEntry {
  readonly nodeKey: string;
  readonly tier: 0 | 1 | 2;
  readonly negPart1: number;
  readonly part2: bigint;
}

function compareHeapEntries(a: HeapEntry, b: HeapEntry): number {
  if (a.tier !== b.tier) {
    return a.tier - b.tier;
  }
  if (a.negPart1 !== b.negPart1) {
    return a.negPart1 - b.negPart1;
  }
  if (a.part2 < b.part2) {
    return -1;
  }
  if (a.part2 > b.part2) {
    return 1;
  }
  return 0;
}

class MinHeap {
  private readonly data: HeapEntry[] = [];

  get size(): number {
    return this.data.length;
  }

  push(entry: HeapEntry): void {
    this.data.push(entry);
    this.siftUp(this.data.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.data.length === 0) {
      return undefined;
    }
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(index: number): void {
    let idx = index;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      if (compareHeapEntries(this.data[idx], this.data[parentIdx]) < 0) {
        const tmp = this.data[idx];
        this.data[idx] = this.data[parentIdx];
        this.data[parentIdx] = tmp;
        idx = parentIdx;
      } else {
        break;
      }
    }
  }

  private siftDown(index: number): void {
    let idx = index;
    const length = this.data.length;
    while (true) {
      let smallest = idx;
      const left = idx * 2 + 1;
      const right = idx * 2 + 2;

      if (left < length && compareHeapEntries(this.data[left], this.data[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && compareHeapEntries(this.data[right], this.data[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === idx) {
        break;
      }
      const tmp = this.data[idx];
      this.data[idx] = this.data[smallest];
      this.data[smallest] = tmp;
      idx = smallest;
    }
  }
}

function createHeapEntry(nodeKey: string, itemMap: ReadonlyMap<string, CrdtSequenceItem<unknown>>): HeapEntry {
  if (nodeKey === START_NODE) {
    return { nodeKey, tier: 0, negPart1: 0, part2: 0n };
  }
  if (nodeKey === END_NODE) {
    return { nodeKey, tier: 2, negPart1: 0, part2: 0n };
  }
  const item = itemMap.get(nodeKey)!;
  return {
    nodeKey,
    tier: 1,
    negPart1: -item.itemId.part1,
    part2: item.itemId.part2,
  };
}

export function toposortItems<T>(items: Iterable<CrdtSequenceItem<T>>): CrdtId[] {
  const itemMap = new Map<string, CrdtSequenceItem<T>>();
  for (const item of items) {
    itemMap.set(crdtIdKey(item.itemId), item);
  }
  if (itemMap.size === 0) {
    return [];
  }

  const resolveSideKey = (sideId: CrdtId, side: 'left' | 'right'): string => {
    if (crdtIdEquals(sideId, END_MARKER)) {
      return side === 'left' ? START_NODE : END_NODE;
    }
    const key = crdtIdKey(sideId);
    if (!itemMap.has(key)) {
      return side === 'left' ? START_NODE : END_NODE;
    }
    return key;
  };

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const allNodes = new Set<string>([START_NODE, END_NODE]);

  const addEdge = (from: string, to: string): void => {
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    let list = dependents.get(from);
    if (!list) {
      list = [];
      dependents.set(from, list);
    }
    list.push(to);
  };

  for (const [itemKey, item] of itemMap) {
    const leftKey = resolveSideKey(item.leftId, 'left');
    const rightKey = resolveSideKey(item.rightId, 'right');

    allNodes.add(itemKey);
    allNodes.add(leftKey);
    allNodes.add(rightKey);

    addEdge(leftKey, itemKey);
    addEdge(itemKey, rightKey);
  }

  const ready = new MinHeap();
  for (const nodeKey of allNodes) {
    if (!inDegree.has(nodeKey)) {
      inDegree.set(nodeKey, 0);
    }
    if (inDegree.get(nodeKey) === 0) {
      ready.push(createHeapEntry(nodeKey, itemMap));
    }
  }

  const orderedIds: CrdtId[] = [];
  while (ready.size > 0) {
    const current = ready.pop()!;
    const found = itemMap.get(current.nodeKey);
    if (found) {
      orderedIds.push(found.itemId);
    }
    if (current.nodeKey === END_NODE) {
      break;
    }

    const nextList = dependents.get(current.nodeKey);
    if (nextList) {
      for (const dep of nextList) {
        const nextDeg = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, nextDeg);
        if (nextDeg === 0) {
          ready.push(createHeapEntry(dep, itemMap));
        }
      }
    }
  }

  for (const nodeKey of allNodes) {
    if (nodeKey !== END_NODE && (inDegree.get(nodeKey) ?? 0) > 0) {
      throw new Error('Cyclic dependency detected in CRDT sequence.');
    }
  }

  return orderedIds;
}

export class CrdtSequence<T> implements Iterable<CrdtId> {
  private readonly itemsByKey = new Map<string, CrdtSequenceItem<T>>();

  constructor(initialItems?: Iterable<CrdtSequenceItem<T>>) {
    if (initialItems) {
      for (const item of initialItems) {
        this.add(item);
      }
    }
  }

  get size(): number {
    return this.itemsByKey.size;
  }

  add(item: CrdtSequenceItem<T>): void {
    const key = crdtIdKey(item.itemId);
    if (this.itemsByKey.has(key)) {
      throw new Error(`Duplicate CRDT sequence item ID ${key}.`);
    }
    this.itemsByKey.set(key, item);
  }

  [Symbol.iterator](): Iterator<CrdtId> {
    return this.keys()[Symbol.iterator]();
  }

  keys(): CrdtId[] {
    return toposortItems(this.itemsByKey.values());
  }

  values(): T[] {
    return this.keys().map((id) => this.get(id)!);
  }

  entries(): Array<[CrdtId, T]> {
    return this.keys().map((id) => [id, this.get(id)!]);
  }

  get(id: CrdtId): T | undefined {
    return this.itemsByKey.get(crdtIdKey(id))?.value;
  }

  sequenceItems(): CrdtSequenceItem<T>[] {
    return Array.from(this.itemsByKey.values());
  }
}

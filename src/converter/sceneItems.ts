/**
 * SceneTree and SceneItem data structures for reMarkable `.rm` documents.
 */

import {
  type CrdtId,
  crdtIdKey,
  END_MARKER,
  type LwwValue,
  type RgbaColor,
  type RmFormatVersion,
  ROOT_ID,
} from './binaryReader';
import { CrdtSequence, type CrdtSequenceItem } from './crdtSequence';

export enum PenColor {
  BLACK = 0,
  GRAY = 1,
  WHITE = 2,
  YELLOW = 3,
  GREEN = 4,
  PINK = 5,
  BLUE = 6,
  RED = 7,
  GRAY_OVERLAP = 8,
  HIGHLIGHT = 9,
  GREEN_2 = 10,
  CYAN = 11,
  MAGENTA = 12,
  YELLOW_2 = 13,
}

export enum PenType {
  PAINTBRUSH_1 = 0,
  PENCIL_1 = 1,
  BALLPOINT_1 = 2,
  MARKER_1 = 3,
  FINELINER_1 = 4,
  HIGHLIGHTER_1 = 5,
  ERASER = 6,
  MECHANICAL_PENCIL_1 = 7,
  ERASER_AREA = 8,
  CALLIGRAPHY_LEGACY = 9,
  PAINTBRUSH_2 = 12,
  MECHANICAL_PENCIL_2 = 13,
  PENCIL_2 = 14,
  BALLPOINT_2 = 15,
  MARKER_2 = 16,
  FINELINER_2 = 17,
  HIGHLIGHTER_2 = 18,
  CALIGRAPHY = 21,
  SHADER = 23,
}

export enum ParagraphStyle {
  BASIC = 0,
  PLAIN = 1,
  HEADING = 2,
  BOLD = 3,
  BULLET = 4,
  BULLET2 = 5,
  CHECKBOX = 6,
  CHECKBOX_CHECKED = 7,
}

export function toParagraphStyle(code: number): ParagraphStyle {
  if (code >= ParagraphStyle.BASIC && code <= ParagraphStyle.CHECKBOX_CHECKED) {
    return code as ParagraphStyle;
  }
  return ParagraphStyle.PLAIN;
}

export interface RmPoint {
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly direction: number;
  readonly width: number;
  readonly pressure: number;
}

export interface RmRectangle {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SceneLineItem {
  readonly kind: 'line';
  readonly color: number;
  readonly tool: number;
  readonly points: readonly RmPoint[];
  readonly thicknessScale: number;
  readonly startingLength: number;
  readonly moveId: CrdtId | null;
  readonly colorRgba: RgbaColor | null;
}

export interface SceneGlyphRangeItem {
  readonly kind: 'glyph';
  readonly start: number | null;
  readonly length: number;
  readonly text: string;
  readonly color: number;
  readonly rectangles: readonly RmRectangle[];
  readonly colorRgba: RgbaColor | null;
}

export interface SceneGroupItem {
  readonly kind: 'group';
  readonly nodeId: CrdtId;
  readonly children: CrdtSequence<SceneItem | null>;
  label: LwwValue<string>;
  visible: LwwValue<boolean>;
  anchorId: LwwValue<CrdtId> | null;
  anchorType: LwwValue<number> | null;
  anchorThreshold: LwwValue<number> | null;
  anchorOriginX: LwwValue<number> | null;
}

export type SceneLeafItem = SceneLineItem | SceneGlyphRangeItem;
export type SceneItem = SceneGroupItem | SceneLeafItem;

export interface SceneTextStyleEntry {
  readonly charId: CrdtId;
  readonly style: LwwValue<ParagraphStyle>;
}

export interface SceneText {
  readonly items: CrdtSequence<string | number>;
  readonly styles: ReadonlyMap<string, SceneTextStyleEntry>;
  readonly posX: number;
  readonly posY: number;
  readonly width: number;
}

export interface SceneInfo {
  readonly currentLayer: LwwValue<CrdtId>;
  readonly backgroundVisible: LwwValue<boolean> | null;
  readonly rootDocumentVisible: LwwValue<boolean> | null;
  readonly paperSize: readonly [number, number] | null;
}

export function createGroupItem(nodeId: CrdtId): SceneGroupItem {
  return {
    kind: 'group',
    nodeId,
    children: new CrdtSequence<SceneItem | null>(),
    label: { timestamp: END_MARKER, value: '' },
    visible: { timestamp: END_MARKER, value: true },
    anchorId: null,
    anchorType: null,
    anchorThreshold: null,
    anchorOriginX: null,
  };
}

export class SceneTree {
  readonly root: SceneGroupItem;
  readonly formatVersion: RmFormatVersion;
  sceneInfo: SceneInfo | null = null;
  rootText: SceneText | null = null;

  private readonly nodesByKey = new Map<string, SceneGroupItem>();

  constructor(formatVersion: RmFormatVersion = 6) {
    this.formatVersion = formatVersion;
    this.root = createGroupItem(ROOT_ID);
    this.nodesByKey.set(crdtIdKey(ROOT_ID), this.root);
  }

  hasNode(nodeId: CrdtId): boolean {
    return this.nodesByKey.has(crdtIdKey(nodeId));
  }

  getNode(nodeId: CrdtId): SceneGroupItem {
    const node = this.nodesByKey.get(crdtIdKey(nodeId));
    if (!node) {
      throw new Error(`SceneTree node not found: ${crdtIdKey(nodeId)}`);
    }
    return node;
  }

  ensureNode(nodeId: CrdtId): SceneGroupItem {
    const key = crdtIdKey(nodeId);
    const existing = this.nodesByKey.get(key);
    if (existing) {
      return existing;
    }
    const created = createGroupItem(nodeId);
    this.nodesByKey.set(key, created);
    return created;
  }

  addItem(item: CrdtSequenceItem<SceneItem | null>, parentId: CrdtId): void {
    const parent = this.ensureNode(parentId);
    parent.children.add(item);
  }

  walk(): SceneLeafItem[] {
    const leaves: SceneLeafItem[] = [];
    const visit = (group: SceneGroupItem): void => {
      for (const child of group.children.values()) {
        if (!child) {
          continue;
        }
        if (child.kind === 'group') {
          visit(child);
        } else {
          leaves.push(child);
        }
      }
    };
    visit(this.root);
    return leaves;
  }
}


/**
 * CRDT text reconstruction, paragraph anchor resolution, and SceneTree bounding box
 * calculation matching `rmscene/text.py` and `rmc/exporters/svg.py`.
 */

import {
  type CrdtId,
  crdtId,
  crdtIdKey,
  END_MARKER,
  type LwwValue,
} from './binaryReader';
import { CrdtSequence, type CrdtSequenceItem } from './crdtSequence';
import {
  ParagraphStyle,
  type SceneGroupItem,
  type SceneText,
} from './sceneItems';

export const RM_SCREEN_WIDTH = 1404;
export const RM_SCREEN_HEIGHT = 1872;
export const TEXT_TOP_Y = -88;

const LINE_HEIGHT_BY_STYLE: Partial<Record<ParagraphStyle, number>> = {
  [ParagraphStyle.PLAIN]: 70,
  [ParagraphStyle.BULLET]: 35,
  [ParagraphStyle.BULLET2]: 35,
  [ParagraphStyle.BOLD]: 70,
  [ParagraphStyle.HEADING]: 150,
  [ParagraphStyle.CHECKBOX]: 35,
  [ParagraphStyle.CHECKBOX_CHECKED]: 35,
};

export function getParagraphLineHeight(style: ParagraphStyle): number {
  return LINE_HEIGHT_BY_STYLE[style] ?? 70;
}

export interface TextSpanProperties {
  readonly 'font-weight': 'normal' | 'bold';
  readonly 'font-style': 'normal' | 'italic';
}

export interface CrdtTextSpan {
  text: string;
  readonly charIds: CrdtId[];
  readonly properties: TextSpanProperties;
}

export interface TextParagraph {
  readonly contents: readonly CrdtTextSpan[];
  readonly startId: CrdtId;
  readonly style: LwwValue<ParagraphStyle>;
  readonly plainText: string;
}

export interface TextDocument {
  readonly contents: readonly TextParagraph[];
}

export function expandTextItem(
  item: CrdtSequenceItem<string | number>
): CrdtSequenceItem<string | number>[] {
  if (typeof item.value === 'number') {
    return [item];
  }

  let chars: string[];
  let deletedLength: number;

  if (item.deletedLength > 0) {
    chars = new Array<string>(item.deletedLength).fill('');
    deletedLength = 1;
  } else {
    chars = Array.from(item.value);
    deletedLength = 0;
  }

  if (chars.length === 0) {
    return [];
  }

  const expanded: CrdtSequenceItem<string | number>[] = [];
  let currentId = item.itemId;
  let currentLeftId = item.leftId;

  for (let i = 0; i < chars.length - 1; i += 1) {
    const nextRightId = crdtId(currentId.part1, currentId.part2 + 1n);
    expanded.push({
      itemId: currentId,
      leftId: currentLeftId,
      rightId: nextRightId,
      deletedLength,
      value: chars[i],
    });
    currentLeftId = currentId;
    currentId = nextRightId;
  }

  expanded.push({
    itemId: currentId,
    leftId: currentLeftId,
    rightId: item.rightId,
    deletedLength,
    value: chars[chars.length - 1],
  });

  return expanded;
}

export function expandTextItems(
  items: Iterable<CrdtSequenceItem<string | number>>
): CrdtSequenceItem<string | number>[] {
  const result: CrdtSequenceItem<string | number>[] = [];
  for (const item of items) {
    const expanded = expandTextItem(item);
    for (const single of expanded) {
      result.push(single);
    }
  }
  return result;
}

function sameSpanProperties(a: TextSpanProperties, b: TextSpanProperties): boolean {
  return a['font-weight'] === b['font-weight'] && a['font-style'] === b['font-style'];
}

export function buildTextDocument(text: SceneText): TextDocument {
  const charSequence = new CrdtSequence<string | number>(
    expandTextItems(text.items.sequenceItems())
  );
  const keys = charSequence.keys();

  let fontWeight: 'normal' | 'bold' = 'normal';
  let fontStyle: 'normal' | 'italic' = 'normal';

  const applyFormatCode = (code: number): void => {
    if (code === 1) {
      fontWeight = 'bold';
    } else if (code === 2) {
      fontWeight = 'normal';
    } else if (code === 3) {
      fontStyle = 'italic';
    } else if (code === 4) {
      fontStyle = 'normal';
    }
  };

  let cursor = 0;
  const paragraphs: TextParagraph[] = [];

  while (cursor < keys.length) {
    let startId: CrdtId = END_MARKER;
    if (charSequence.get(keys[cursor]) === '\n') {
      startId = keys[cursor];
      cursor += 1;
    }

    const spans: CrdtTextSpan[] = [];

    while (cursor < keys.length) {
      const charId = keys[cursor];
      const value = charSequence.get(charId);

      if (typeof value === 'number') {
        applyFormatCode(value);
        cursor += 1;
        continue;
      }

      if (value === '\n') {
        break;
      }

      const currentProps: TextSpanProperties = {
        'font-weight': fontWeight,
        'font-style': fontStyle,
      };

      const lastSpan = spans[spans.length - 1];
      if (!lastSpan || !sameSpanProperties(lastSpan.properties, currentProps)) {
        spans.push({
          text: value ?? '',
          charIds: [charId],
          properties: currentProps,
        });
      } else {
        lastSpan.text += value ?? '';
        lastSpan.charIds.push(charId);
      }

      cursor += 1;
    }

    const styleEntry = text.styles.get(crdtIdKey(startId));
    const style: LwwValue<ParagraphStyle> = styleEntry
      ? styleEntry.style
      : { timestamp: END_MARKER, value: ParagraphStyle.PLAIN };

    paragraphs.push({
      contents: spans,
      startId,
      style,
      plainText: spans.map((s) => s.text).join(''),
    });
  }

  return { contents: paragraphs };
}

const SPECIAL_TOP_ANCHOR_ID = crdtId(0, 281474976710654n);
const SPECIAL_BOTTOM_ANCHOR_ID = crdtId(0, 281474976710655n);

export type AnchorPositionMap = ReadonlyMap<string, number>;

export function buildAnchorPos(rootText: SceneText | null): AnchorPositionMap {
  const anchorPos = new Map<string, number>([
    [crdtIdKey(SPECIAL_TOP_ANCHOR_ID), 100],
    [crdtIdKey(SPECIAL_BOTTOM_ANCHOR_ID), 100],
  ]);

  if (rootText !== null) {
    const doc = buildTextDocument(rootText);
    let yPos = rootText.posY + TEXT_TOP_Y;

    for (const paragraph of doc.contents) {
      anchorPos.set(crdtIdKey(paragraph.startId), yPos);
      for (const span of paragraph.contents) {
        for (const charId of span.charIds) {
          anchorPos.set(crdtIdKey(charId), yPos);
        }
      }
      yPos += getParagraphLineHeight(paragraph.style.value);
    }
  }

  return anchorPos;
}

export function getGroupAnchor(
  group: SceneGroupItem,
  anchorPos: AnchorPositionMap
): readonly [number, number] {
  if (group.anchorId === null) {
    return [0, 0];
  }
  const anchorX = group.anchorOriginX ? group.anchorOriginX.value : 0;
  const anchorY = anchorPos.get(crdtIdKey(group.anchorId.value)) ?? 0;
  return [anchorX, anchorY];
}

export interface BoundingBox {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

const DEFAULT_SCREEN_BOX: BoundingBox = {
  xMin: -Math.floor(RM_SCREEN_WIDTH / 2),
  xMax: Math.floor(RM_SCREEN_WIDTH / 2),
  yMin: 0,
  yMax: RM_SCREEN_HEIGHT,
};

const ZERO_BOX: BoundingBox = {
  xMin: 0,
  xMax: 0,
  yMin: 0,
  yMax: 0,
};

export function getBoundingBox(
  group: SceneGroupItem,
  anchorPos: AnchorPositionMap,
  defaultBox: BoundingBox = DEFAULT_SCREEN_BOX
): BoundingBox {
  let { xMin, xMax, yMin, yMax } = defaultBox;

  for (const child of group.children.values()) {
    if (!child) {
      continue;
    }
    if (child.kind === 'group') {
      const [anchorX, anchorY] = getGroupAnchor(child, anchorPos);
      const childBox = getBoundingBox(child, anchorPos, ZERO_BOX);
      xMin = Math.min(xMin, childBox.xMin + anchorX);
      xMax = Math.max(xMax, childBox.xMax + anchorX);
      yMin = Math.min(yMin, childBox.yMin + anchorY);
      yMax = Math.max(yMax, childBox.yMax + anchorY);
    } else if (child.kind === 'line') {
      for (const pt of child.points) {
        if (pt.x < xMin) xMin = pt.x;
        if (pt.x > xMax) xMax = pt.x;
        if (pt.y < yMin) yMin = pt.y;
        if (pt.y > yMax) yMax = pt.y;
      }
    }
  }

  return { xMin, xMax, yMin, yMax };
}


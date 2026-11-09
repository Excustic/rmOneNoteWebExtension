/**
 * Parser for reMarkable `.rm` binary streams (v6 CRDT SceneTree and legacy v3/v5).
 *
 * Implements block-level decoding from `ricklupton/rmscene` (`scene_stream.py`)
 * with error containment per block so unknown or future block types never abort
 * conversion of the rest of a page, plus legacy v3/v5 stroke unmarshaling.
 */

import {
  type CrdtId,
  crdtId,
  crdtIdKey,
  END_MARKER,
  type LwwValue,
  type MainBlockInfo,
  RmDataStream,
  ROOT_ID,
  TaggedBlockReader,
  UnexpectedBlockError,
} from './binaryReader';
import { CrdtSequence, type CrdtSequenceItem } from './crdtSequence';
import {
  PenColor,
  PenType,
  type RmPoint,
  type RmRectangle,
  type SceneGlyphRangeItem,
  type SceneGroupItem,
  type SceneInfo,
  type SceneLineItem,
  type SceneText,
  type SceneTextStyleEntry,
  SceneTree,
  toParagraphStyle,
} from './sceneItems';

const V3_V5_X_CENTER_SHIFT = 1404 / 2;

export enum RmBlockType {
  MigrationInfo = 0x00,
  SceneTree = 0x01,
  TreeNode = 0x02,
  SceneGlyphItem = 0x03,
  SceneGroupItem = 0x04,
  SceneLineItem = 0x05,
  SceneTextItem = 0x06,
  RootText = 0x07,
  SceneTombstoneItem = 0x08,
  AuthorIds = 0x09,
  PageInfo = 0x0a,
  SceneInfo = 0x0d,
}

const ITEM_TYPE_GLYPH = 0x01;
const ITEM_TYPE_GROUP = 0x02;
const ITEM_TYPE_LINE = 0x03;
const ITEM_TYPE_TEXT = 0x05;

export interface MigrationInfoParsedBlock {
  readonly kind: 'migration_info';
  readonly migrationId: CrdtId;
  readonly isDevice: boolean;
  readonly unknownFlag: boolean;
  readonly extraData: Uint8Array;
}

export interface AuthorIdsParsedBlock {
  readonly kind: 'author_ids';
  readonly authorUuids: ReadonlyMap<number, Uint8Array>;
  readonly extraData: Uint8Array;
}

export interface PageInfoParsedBlock {
  readonly kind: 'page_info';
  readonly loadsCount: number;
  readonly mergesCount: number;
  readonly textCharsCount: number;
  readonly textLinesCount: number;
  readonly typeFolioUseCount: number;
  readonly extraData: Uint8Array;
}

export interface SceneInfoParsedBlock {
  readonly kind: 'scene_info';
  readonly info: SceneInfo;
  readonly extraData: Uint8Array;
}

export interface SceneTreeParsedBlock {
  readonly kind: 'scene_tree';
  readonly treeId: CrdtId;
  readonly nodeId: CrdtId;
  readonly isUpdate: boolean;
  readonly parentId: CrdtId;
  readonly extraData: Uint8Array;
}

export interface TreeNodeParsedBlock {
  readonly kind: 'tree_node';
  readonly nodeId: CrdtId;
  readonly label: LwwValue<string>;
  readonly visible: LwwValue<boolean>;
  readonly anchorId: LwwValue<CrdtId> | null;
  readonly anchorType: LwwValue<number> | null;
  readonly anchorThreshold: LwwValue<number> | null;
  readonly anchorOriginX: LwwValue<number> | null;
  readonly extraData: Uint8Array;
}

export type SceneItemBlockKind =
  | 'scene_group_item'
  | 'scene_line_item'
  | 'scene_glyph_item'
  | 'scene_text_item'
  | 'scene_tombstone_item';

export interface SceneItemParsedBlock<K extends SceneItemBlockKind, T> {
  readonly kind: K;
  readonly parentId: CrdtId;
  readonly item: CrdtSequenceItem<T | null>;
  readonly extraValueData: Uint8Array;
  readonly extraData: Uint8Array;
}

export interface RootTextParsedBlock {
  readonly kind: 'root_text';
  readonly blockId: CrdtId;
  readonly text: SceneText;
  readonly extraData: Uint8Array;
}

export interface UnreadableParsedBlock {
  readonly kind: 'unreadable';
  readonly error: string;
  readonly data: Uint8Array;
  readonly info: MainBlockInfo;
  readonly extraData: Uint8Array;
}

export type ParsedRmBlock =
  | MigrationInfoParsedBlock
  | AuthorIdsParsedBlock
  | PageInfoParsedBlock
  | SceneInfoParsedBlock
  | SceneTreeParsedBlock
  | TreeNodeParsedBlock
  | SceneItemParsedBlock<'scene_group_item', CrdtId>
  | SceneItemParsedBlock<'scene_line_item', SceneLineItem>
  | SceneItemParsedBlock<'scene_glyph_item', SceneGlyphRangeItem>
  | SceneItemParsedBlock<'scene_text_item', null>
  | SceneItemParsedBlock<'scene_tombstone_item', null>
  | RootTextParsedBlock
  | UnreadableParsedBlock;

function readPointFromStream(reader: TaggedBlockReader, version: number): RmPoint {
  const d = reader.data;
  const x = d.readFloat32();
  const y = d.readFloat32();
  if (version === 1) {
    const speed = d.readFloat32() * 4;
    const direction = (255 * d.readFloat32()) / (Math.PI * 2);
    const width = Math.round(d.readFloat32() * 4);
    const pressure = d.readFloat32() * 255;
    return { x, y, speed, direction, width, pressure };
  }
  const speed = d.readUint16();
  const width = d.readUint16();
  const direction = d.readUint8();
  const pressure = d.readUint8();
  return { x, y, speed, direction, width, pressure };
}

function readLineFromStream(reader: TaggedBlockReader, blockVersion: number): SceneLineItem {
  const pointVersion = blockVersion >= 2 ? 2 : 1;
  const pointSize = pointVersion === 1 ? 0x18 : 0x0e;

  const tool = reader.readInt(1);
  const color = reader.readInt(2);
  const thicknessScale = reader.readDouble(3);
  const startingLength = reader.readFloat(4);

  const points = reader.readSubblock(5, (subblock) => {
    if (subblock.size % pointSize !== 0) {
      throw new UnexpectedBlockError(
        `Point data size mismatch: ${subblock.size} is not a multiple of ${pointSize}.`
      );
    }
    const count = subblock.size / pointSize;
    const decoded: RmPoint[] = [];
    for (let i = 0; i < count; i += 1) {
      decoded.push(readPointFromStream(reader, pointVersion));
    }
    return decoded;
  });

  // Timestamp tag (index 6) is present in v6 strokes
  reader.readId(6);

  const moveId =
    reader.bytesRemainingInCurrentScope() >= 3 ? reader.readIdOptional(7) : null;
  const colorRgba = reader.readColorOptional(8);

  return {
    kind: 'line',
    color,
    tool,
    points,
    thicknessScale,
    startingLength,
    moveId,
    colorRgba,
  };
}

function readGlyphRangeFromStream(reader: TaggedBlockReader): SceneGlyphRangeItem {
  const start = reader.readIntOptional(2);
  const rawLength = reader.readIntOptional(3);
  const color = reader.readInt(4);
  const text = reader.readString(5);
  const length = rawLength ?? text.length;

  const rectangles = reader.readSubblock(6, () => {
    const count = reader.data.readVaruint();
    const rects: RmRectangle[] = [];
    for (let i = 0; i < count; i += 1) {
      rects.push({
        x: reader.data.readFloat64(),
        y: reader.data.readFloat64(),
        w: reader.data.readFloat64(),
        h: reader.data.readFloat64(),
      });
    }
    return rects;
  });

  const colorRgba = reader.readColorOptional(10);

  return {
    kind: 'glyph',
    start,
    length,
    text,
    color,
    rectangles,
    colorRgba,
  };
}

function readSceneItemEnvelope<K extends SceneItemBlockKind, T>(
  reader: TaggedBlockReader,
  kind: K,
  expectedItemType: number | null,
  decodeValue: ((r: TaggedBlockReader) => T) | null
): SceneItemParsedBlock<K, T> {
  const parentId = reader.readId(1);
  const itemId = reader.readId(2);
  const leftId = reader.readId(3);
  const rightId = reader.readId(4);
  const deletedLength = reader.readInt(5);

  let value: T | null = null;
  let extraValueData: Uint8Array = new Uint8Array(0);

  if (reader.hasSubblock(6)) {
    const subInfo = reader.readSubblock(6, (sub) => {
      const actualItemType = reader.data.readUint8();
      if (expectedItemType !== null && actualItemType !== expectedItemType) {
        throw new UnexpectedBlockError(
          `Expected scene item type 0x${expectedItemType.toString(16)}, got 0x${actualItemType.toString(16)}.`
        );
      }
      if (decodeValue) {
        value = decodeValue(reader);
      }
      return sub;
    });
    extraValueData = subInfo.extraData;
  }

  return {
    kind,
    parentId,
    item: {
      itemId,
      leftId,
      rightId,
      deletedLength,
      value,
    },
    extraValueData,
    extraData: new Uint8Array(0),
  };
}

function readTextItemFromStream(reader: TaggedBlockReader): CrdtSequenceItem<string | number> {
  return reader.readSubblock(0, () => {
    const itemId = reader.readId(2);
    const leftId = reader.readId(3);
    const rightId = reader.readId(4);
    const deletedLength = reader.readInt(5);

    let value: string | number = '';
    if (reader.hasSubblock(6)) {
      const { text, format } = reader.readStringWithFormat(6);
      value = format !== null ? format : text;
    }

    return {
      itemId,
      leftId,
      rightId,
      deletedLength,
      value,
    };
  });
}

function readTextFormatFromStream(reader: TaggedBlockReader): SceneTextStyleEntry {
  const charId = reader.data.readCrdtId();
  const timestamp = reader.readId(1);
  const formatType = reader.readSubblock(2, () => {
    const prefix = reader.data.readUint8();
    if (prefix !== 17) {
      throw new UnexpectedBlockError(`Unexpected text format prefix byte ${prefix} (expected 17).`);
    }
    const formatCode = reader.data.readUint8();
    return toParagraphStyle(formatCode);
  });

  return {
    charId,
    style: { timestamp, value: formatType },
  };
}

function readRootTextBlock(reader: TaggedBlockReader): RootTextParsedBlock {
  const blockId = reader.readId(1);

  const { textItems, styles } = reader.readSubblock(2, () => {
    const items = reader.readSubblock(1, () =>
      reader.readSubblock(1, () => {
        const count = reader.data.readVaruint();
        const list: Array<CrdtSequenceItem<string | number>> = [];
        for (let i = 0; i < count; i += 1) {
          list.push(readTextItemFromStream(reader));
        }
        return list;
      })
    );

    const styleMap = reader.readSubblock(2, () =>
      reader.readSubblock(1, () => {
        const count = reader.data.readVaruint();
        const map = new Map<string, SceneTextStyleEntry>();
        for (let i = 0; i < count; i += 1) {
          const entry = readTextFormatFromStream(reader);
          map.set(crdtIdKey(entry.charId), entry);
        }
        return map;
      })
    );

    return { textItems: items, styles: styleMap };
  });

  const { posX, posY } = reader.readSubblock(3, () => ({
    posX: reader.data.readFloat64(),
    posY: reader.data.readFloat64(),
  }));

  const width = reader.readFloat(4);

  return {
    kind: 'root_text',
    blockId,
    text: {
      items: new CrdtSequence<string | number>(textItems),
      styles,
      posX,
      posY,
      width,
    },
    extraData: new Uint8Array(0),
  };
}

function parseSingleV6Block(reader: TaggedBlockReader, blockInfo: MainBlockInfo): ParsedRmBlock {
  switch (blockInfo.blockType) {
    case RmBlockType.MigrationInfo: {
      const migrationId = reader.readId(1);
      const isDevice = reader.readBool(2);
      const unknownFlag =
        reader.bytesRemainingInCurrentScope() > 0
          ? reader.readBoolOptional(3) ?? false
          : false;
      return {
        kind: 'migration_info',
        migrationId,
        isDevice,
        unknownFlag,
        extraData: new Uint8Array(0),
      };
    }

    case RmBlockType.AuthorIds: {
      const count = reader.data.readVaruint();
      const authorUuids = new Map<number, Uint8Array>();
      for (let i = 0; i < count; i += 1) {
        reader.readSubblock(0, () => {
          const uuidLength = reader.data.readVaruint();
          if (uuidLength !== 16) {
            throw new UnexpectedBlockError(`Expected 16-byte author UUID, got ${uuidLength}.`);
          }
          const rawUuid = new Uint8Array(reader.data.readBytes(uuidLength));
          const authorId = reader.data.readUint16();
          authorUuids.set(authorId, rawUuid);
        });
      }
      return {
        kind: 'author_ids',
        authorUuids,
        extraData: new Uint8Array(0),
      };
    }

    case RmBlockType.PageInfo: {
      const loadsCount = reader.readInt(1);
      const mergesCount = reader.readInt(2);
      const textCharsCount = reader.readInt(3);
      const textLinesCount = reader.readInt(4);
      const typeFolioUseCount =
        reader.bytesRemainingInCurrentScope() > 0 ? reader.readIntOptional(5) ?? 0 : 0;
      return {
        kind: 'page_info',
        loadsCount,
        mergesCount,
        textCharsCount,
        textLinesCount,
        typeFolioUseCount,
        extraData: new Uint8Array(0),
      };
    }

    case RmBlockType.SceneInfo: {
      const currentLayer = reader.readLwwId(1);
      const backgroundVisible = reader.hasSubblock(2) ? reader.readLwwBool(2) : null;
      const rootDocumentVisible = reader.hasSubblock(3) ? reader.readLwwBool(3) : null;
      const paperSize = reader.hasSubblock(5) ? reader.readIntPair(5) : null;
      return {
        kind: 'scene_info',
        info: {
          currentLayer,
          backgroundVisible,
          rootDocumentVisible,
          paperSize,
        },
        extraData: new Uint8Array(0),
      };
    }

    case RmBlockType.SceneTree: {
      const treeId = reader.readId(1);
      const nodeId = reader.readId(2);
      const isUpdate = reader.readBool(3);
      const parentId = reader.readSubblock(4, () => reader.readId(1));
      return {
        kind: 'scene_tree',
        treeId,
        nodeId,
        isUpdate,
        parentId,
        extraData: new Uint8Array(0),
      };
    }

    case RmBlockType.TreeNode: {
      const nodeId = reader.readId(1);
      const label = reader.readLwwString(2);
      const visible = reader.readLwwBool(3);
      const anchorId = reader.hasSubblock(7) ? reader.readLwwId(7) : null;
      const anchorType = reader.hasSubblock(8) ? reader.readLwwByte(8) : null;
      const anchorThreshold = reader.hasSubblock(9) ? reader.readLwwFloat(9) : null;
      const anchorOriginX = reader.hasSubblock(10) ? reader.readLwwFloat(10) : null;
      return {
        kind: 'tree_node',
        nodeId,
        label,
        visible,
        anchorId,
        anchorType,
        anchorThreshold,
        anchorOriginX,
        extraData: new Uint8Array(0),
      };
    }

    case RmBlockType.SceneGroupItem:
      return readSceneItemEnvelope<'scene_group_item', CrdtId>(
        reader,
        'scene_group_item',
        ITEM_TYPE_GROUP,
        (r) => r.readId(2)
      );

    case RmBlockType.SceneLineItem:
      return readSceneItemEnvelope<'scene_line_item', SceneLineItem>(
        reader,
        'scene_line_item',
        ITEM_TYPE_LINE,
        (r) => readLineFromStream(r, blockInfo.currentVersion)
      );

    case RmBlockType.SceneGlyphItem:
      return readSceneItemEnvelope<'scene_glyph_item', SceneGlyphRangeItem>(
        reader,
        'scene_glyph_item',
        ITEM_TYPE_GLYPH,
        (r) => readGlyphRangeFromStream(r)
      );

    case RmBlockType.SceneTextItem:
      return readSceneItemEnvelope<'scene_text_item', null>(
        reader,
        'scene_text_item',
        ITEM_TYPE_TEXT,
        null
      );

    case RmBlockType.SceneTombstoneItem:
      return readSceneItemEnvelope<'scene_tombstone_item', null>(
        reader,
        'scene_tombstone_item',
        null,
        null
      );

    case RmBlockType.RootText:
      return readRootTextBlock(reader);

    default: {
      const data = new Uint8Array(reader.data.readBytes(blockInfo.size));
      return {
        kind: 'unreadable',
        error: `Unknown block type ${blockInfo.blockType}. Skipping ${blockInfo.size} bytes.`,
        data,
        info: blockInfo,
        extraData: new Uint8Array(0),
      };
    }
  }
}

/**
 * Reads all blocks from a v6 `.rm` byte buffer.
 * Any malformed or unrecognised block is isolated as an `UnreadableParsedBlock`
 * so subsequent blocks continue to parse cleanly.
 */
export function readRmV6Blocks(bytes: Uint8Array): ParsedRmBlock[] {
  const reader = new TaggedBlockReader(bytes);
  reader.readHeader();

  const blocks: ParsedRmBlock[] = [];
  while (true) {
    let capturedInfo: MainBlockInfo | null = null;
    const parsed = reader.readBlock<ParsedRmBlock>((blockInfo) => {
      capturedInfo = blockInfo;
      try {
        return parseSingleV6Block(reader, blockInfo);
      } catch (err) {
        reader.data.seek(blockInfo.offset);
        const rawBlockBytes = new Uint8Array(reader.data.readBytes(blockInfo.size));
        return {
          kind: 'unreadable',
          error: err instanceof Error ? err.message : String(err),
          data: rawBlockBytes,
          info: blockInfo,
          extraData: new Uint8Array(0),
        };
      }
    });

    if (parsed === null) {
      break;
    }

    const extraData = capturedInfo ? (capturedInfo as MainBlockInfo).extraData : new Uint8Array(0);
    blocks.push({ ...parsed, extraData });
  }

  return blocks;
}

export function buildSceneTreeFromBlocks(blocks: Iterable<ParsedRmBlock>): SceneTree {
  const tree = new SceneTree(6);

  for (const block of blocks) {
    switch (block.kind) {
      case 'scene_tree': {
        tree.ensureNode(block.treeId);
        break;
      }

      case 'tree_node': {
        const node = tree.ensureNode(block.nodeId);
        node.label = block.label;
        node.visible = block.visible;
        node.anchorId = block.anchorId;
        node.anchorType = block.anchorType;
        node.anchorThreshold = block.anchorThreshold;
        node.anchorOriginX = block.anchorOriginX;
        break;
      }

      case 'scene_group_item': {
        const targetNodeId = block.item.value;
        if (targetNodeId === null) {
          tree.addItem(
            {
              itemId: block.item.itemId,
              leftId: block.item.leftId,
              rightId: block.item.rightId,
              deletedLength: block.item.deletedLength,
              value: null,
            },
            block.parentId
          );
          break;
        }
        const groupNode: SceneGroupItem = tree.ensureNode(targetNodeId);
        tree.addItem(
          {
            itemId: block.item.itemId,
            leftId: block.item.leftId,
            rightId: block.item.rightId,
            deletedLength: block.item.deletedLength,
            value: groupNode,
          },
          block.parentId
        );
        break;
      }

      case 'scene_line_item':
      case 'scene_glyph_item': {
        tree.addItem(block.item, block.parentId);
        break;
      }

      case 'scene_info': {
        tree.sceneInfo = block.info;
        break;
      }

      case 'root_text': {
        tree.rootText = block.text;
        break;
      }

      default:
        break;
    }
  }

  return tree;
}

function parseLegacyV3OrV5SceneTree(stream: RmDataStream, version: 3 | 5): SceneTree {
  const tree = new SceneTree(version);
  const numLayers = stream.readUint32();

  let prevLayerItemId: CrdtId = END_MARKER;
  let nextSyntheticId = 100n;

  for (let layerIdx = 0; layerIdx < numLayers; layerIdx += 1) {
    const layerNodeId = crdtId(0, nextSyntheticId++);
    const layerGroup = tree.ensureNode(layerNodeId);
    layerGroup.label = { timestamp: END_MARKER, value: `Layer ${layerIdx + 1}` };

    const layerSeqItemId = crdtId(0, nextSyntheticId++);
    tree.addItem(
      {
        itemId: layerSeqItemId,
        leftId: prevLayerItemId,
        rightId: END_MARKER,
        deletedLength: 0,
        value: layerGroup,
      },
      ROOT_ID
    );
    prevLayerItemId = layerSeqItemId;

    const numLines = stream.readUint32();
    let prevLineItemId: CrdtId = END_MARKER;

    for (let lineIdx = 0; lineIdx < numLines; lineIdx += 1) {
      const brushType = stream.readUint32();
      let brushColor = stream.readUint32();
      // padding uint32
      stream.readUint32();
      const brushSize = stream.readFloat32();
      if (version === 5) {
        // v5 unknown float32 attribute
        stream.readFloat32();
      }

      // Legacy v3/v5 highlighters stored BrushColor=0 (Black) when only yellow existed
      if (
        (brushType === PenType.HIGHLIGHTER_1 || brushType === PenType.HIGHLIGHTER_2) &&
        brushColor === PenColor.BLACK
      ) {
        brushColor = PenColor.YELLOW;
      }

      const numPoints = stream.readUint32();
      const points: RmPoint[] = [];
      for (let p = 0; p < numPoints; p += 1) {
        const rawX = stream.readFloat32();
        const y = stream.readFloat32();
        const speed = stream.readFloat32() * 4;
        const direction = (255 * stream.readFloat32()) / (Math.PI * 2);
        const width = Math.round(stream.readFloat32() * 4);
        const pressure = stream.readFloat32() * 255;
        points.push({
          x: rawX - V3_V5_X_CENTER_SHIFT,
          y,
          speed,
          direction,
          width,
          pressure,
        });
      }

      const lineItemId = crdtId(1, nextSyntheticId++);
      const lineItem: SceneLineItem = {
        kind: 'line',
        color: brushColor,
        tool: brushType,
        points,
        thicknessScale: brushSize,
        startingLength: 0,
        moveId: null,
        colorRgba: null,
      };

      tree.addItem(
        {
          itemId: lineItemId,
          leftId: prevLineItemId,
          rightId: END_MARKER,
          deletedLength: 0,
          value: lineItem,
        },
        layerNodeId
      );
      prevLineItemId = lineItemId;
    }
  }

  return tree;
}

/**
 * Parses a reMarkable `.rm` binary file (v6, v5, or v3) into a `SceneTree`.
 * Returns an empty SceneTree for zero-length byte buffers (unannotated pages).
 */
export function parseRmSceneTree(bytes: Uint8Array): SceneTree {
  if (bytes.byteLength === 0) {
    return new SceneTree(6);
  }
  const probe = new RmDataStream(bytes);
  const version = probe.readHeaderVersion();
  if (version === 6) {
    const blocks = readRmV6Blocks(bytes);
    return buildSceneTreeFromBlocks(blocks);
  }
  return parseLegacyV3OrV5SceneTree(probe, version);
}

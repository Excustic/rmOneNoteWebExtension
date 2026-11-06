/**
 * Public API for the native TypeScript `.rm` -> OneNote InkML + Presentation HTML converter.
 */

import { type DownloadBlobOptions, downloadPageRmBytes } from '../remarkable/sync15Client';
import {
  convertRmPage,
  type RmConversionOptions,
  type RmConversionResult,
} from './inkmlExporter';

export {
  BlockOverflowError,
  type CrdtId,
  crdtId,
  crdtIdEquals,
  crdtIdKey,
  END_MARKER,
  formatCrdtId,
  type LwwValue,
  type MainBlockInfo,
  type RgbaColor,
  RM_HEADER_LENGTH,
  RM_HEADER_V3,
  RM_HEADER_V5,
  RM_HEADER_V6,
  RmDataStream,
  RmEofError,
  type RmFormatVersion,
  ROOT_ID,
  type SubBlockInfo,
  TaggedBlockReader,
  TagType,
  UnexpectedBlockError,
} from './binaryReader';
export {
  CrdtSequence,
  type CrdtSequenceItem,
  toposortItems,
} from './crdtSequence';
export {
  convertRmPage,
  escapeHtml,
  INKML_DEFAULT_CHANNEL_MAX,
  INKML_HEIGHT_CONV_CONSTANT,
  INKML_PRESSURE_CONV_CONSTANT,
  INKML_WIDTH_CONV_CONSTANT,
  INKML_X_PAD,
  INKML_Y_PAD,
  type RmConversionOptions,
  type RmConversionResult,
  sceneTreeToInkMlXml,
  sceneTreeToPresentationHtml,
} from './inkmlExporter';
export {
  buildSceneTreeFromBlocks,
  type ParsedRmBlock,
  parseRmSceneTree,
  readRmV6Blocks,
  RmBlockType,
} from './rmParser';
export {
  createGroupItem,
  ParagraphStyle,
  PenColor,
  PenType,
  type RmPoint,
  type RmRectangle,
  type SceneGlyphRangeItem,
  type SceneGroupItem,
  type SceneInfo,
  type SceneItem,
  type SceneLeafItem,
  type SceneLineItem,
  type SceneText,
  type SceneTextStyleEntry,
  SceneTree,
  toParagraphStyle,
} from './sceneItems';
export {
  type AnchorPositionMap,
  type BoundingBox,
  buildAnchorPos,
  buildTextDocument,
  type CrdtTextSpan,
  expandTextItem,
  expandTextItems,
  getBoundingBox,
  getGroupAnchor,
  getParagraphLineHeight,
  RM_SCREEN_HEIGHT,
  RM_SCREEN_WIDTH,
  TEXT_TOP_Y,
  type TextDocument,
  type TextParagraph,
  type TextSpanProperties,
} from './textLayout';
export {
  createInkPen,
  generateBrushIdFromPen,
  type InkPen,
  RM_PALETTE,
  type RgbTuple,
  rgbToHex,
} from './writingTools';

export interface DownloadAndConvertPageOptions extends DownloadBlobOptions, RmConversionOptions {}

/**
 * Downloads a `.rm` page binary from reMarkable Sync15 in memory and converts it
 * directly into OneNote InkML (`application/inkml+xml`) and Presentation HTML (`text/html`).
 */
export async function downloadAndConvertRmPage(
  documentId: string,
  pageId: string,
  options: DownloadAndConvertPageOptions = {}
): Promise<RmConversionResult> {
  const rmBytes = await downloadPageRmBytes(documentId, pageId, options);
  return convertRmPage(rmBytes, {
    pageTitle: options.pageTitle,
    includeBackgroundImageRef: options.includeBackgroundImageRef,
  });
}


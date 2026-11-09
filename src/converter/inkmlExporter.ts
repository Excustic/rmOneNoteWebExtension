/**
 * Stateless `.rm` SceneTree to OneNote InkML (`application/inkml+xml`) and
 * Presentation HTML (`text/html`) exporter.
 *
 * Ported from `rmc/src/rmc/exporters/inmkl.py` with local per-invocation state
 * so concurrent conversions inside the extension service worker never share
 * mutable globals (`trace_id` or bounding-box coordinates).
 */

import { formatCrdtId, type RmFormatVersion } from './binaryReader';
import { parseRmSceneTree } from './rmParser';
import type { SceneGroupItem, SceneLineItem, SceneTree } from './sceneItems';
import {
  type AnchorPositionMap,
  type BoundingBox,
  buildAnchorPos,
  buildTextDocument,
  getBoundingBox,
  getGroupAnchor,
  getParagraphLineHeight,
} from './textLayout';
import {
  createInkPen,
  generateBrushIdFromPen,
  type InkPen,
} from './writingTools';

export const INKML_X_PAD = 0;
export const INKML_Y_PAD = 600;
export const INKML_WIDTH_CONV_CONSTANT = 10;
export const INKML_HEIGHT_CONV_CONSTANT = 10;
export const INKML_PRESSURE_CONV_CONSTANT = 128;
export const INKML_DEFAULT_CHANNEL_MAX = 32767;

/**
 * reMarkable stores strokes in device pixels at 226 DPI, while PDF geometry is
 * in points (72 per inch). xochitl places a PDF page so that 1 pt maps to
 * exactly 226/72 `.rm` units, horizontally centered on `x = 0` and starting at
 * `y = 0`. Knowing this lets us map strokes onto OneNote's PDF printout using
 * physical units instead of guessing from the stroke bounding box.
 */
export const RM_DPI = 226;
export const PDF_POINTS_PER_INCH = 72;
export const HIMETRIC_PER_INCH = 2540;

/** Physical conversion factor from `.rm` units to himetric (`2540 / 226`). */
export const INKML_LANDSCAPE_PDF_CONV_CONSTANT = HIMETRIC_PER_INCH / RM_DPI;
/** The PDF top edge is already `y = 0` in `.rm` space, so no vertical pad. */
export const INKML_LANDSCAPE_PDF_Y_PAD = 0;

const XML_HEADER =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<inkml:ink xmlns:emma="http://www.w3.org/2003/04/emma" ' +
  'xmlns:msink="http://schemas.microsoft.com/ink/2010/main" ' +
  'xmlns:inkml="http://www.w3.org/2003/InkML">\n';

export interface RmConversionOptions {
  /** Page title placed in `<head><title>...</title></head>` for OneNote. */
  readonly pageTitle?: string;
  /**
   * When true, inserts `<img data-render-src="name:background" ... />` inside
   * `<body>` for annotated PDF background image multipart uploads.
   */
  readonly includeBackgroundImageRef?: boolean;
  /**
   * Optional effective visual dimensions (in PDF points) of the underlying PDF
   * page when syncing an annotated PDF. Used to align horizontal (landscape)
   * PDF coordinate origins and scale with OneNote's native PDF renderer.
   */
  readonly pdfPageSizePt?: {
    readonly widthPt: number;
    readonly heightPt: number;
  } | null;
}

export interface RmConversionResult {
  readonly inkmlXml: string;
  readonly presentationHtml: string;
  readonly traceCount: number;
  readonly paragraphCount: number;
  readonly formatVersion: RmFormatVersion;
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeTextWithLineBreaks(raw: string): string {
  return escapeHtml(raw).replace(/\u2028/g, '<br>').replace(/\u2029/g, '<br>');
}

function collectUsedPens(tree: SceneTree): InkPen[] {
  const pens: InkPen[] = [];
  const seenBrushIds = new Set<string>();

  for (const item of tree.walk()) {
    if (item.kind !== 'line' || item.points.length === 0) {
      continue;
    }
    const pen = createInkPen(item.tool, item.color, item.thicknessScale, item.colorRgba);
    const brushId = generateBrushIdFromPen(pen);
    if (!seenBrushIds.has(brushId)) {
      seenBrushIds.add(brushId);
      pens.push(pen);
    }
  }

  return pens;
}

function formatTransparency(strokeOpacity: number): string {
  const transparency = Number((1 - strokeOpacity).toFixed(4));
  return String(transparency);
}

function renderDefinitionsXml(pens: readonly InkPen[]): string {
  const parts: string[] = [];
  parts.push('  <inkml:definitions>');
  parts.push(`
    <inkml:context xml:id="ctxCoordinatesWithPressure">
        <inkml:inkSource xml:id="inkSrcCoordinatesWithPressure">
            <inkml:traceFormat>
                <inkml:channel name="X" type="integer" max="${INKML_DEFAULT_CHANNEL_MAX}" units="himetric" />
                <inkml:channel name="Y" type="integer" max="${INKML_DEFAULT_CHANNEL_MAX}" units="himetric" />
                <inkml:channel name="F" type="integer" max="${INKML_DEFAULT_CHANNEL_MAX}" units="dev" />
            </inkml:traceFormat>
            <inkml:channelProperties>
                <inkml:channelProperty channel="X" name="resolution" value="1" units="1/himetric" />
                <inkml:channelProperty channel="Y" name="resolution" value="1" units="1/himetric" />
                <inkml:channelProperty channel="F" name="resolution" value="1" units="1/dev" />
            </inkml:channelProperties>
        </inkml:inkSource>
    </inkml:context>
    `);

  for (const pen of pens) {
    const brushId = generateBrushIdFromPen(pen);
    const widthHimetric = Math.trunc(pen.strokeWidth * INKML_WIDTH_CONV_CONSTANT);
    const heightHimetric = Math.trunc(pen.strokeWidth * INKML_HEIGHT_CONV_CONSTANT);
    const transparency = formatTransparency(pen.strokeOpacity);

    parts.push(`
    <inkml:brush xml:id="${brushId}">
        <inkml:brushProperty name="width" value="${widthHimetric}" units="himetric" />
        <inkml:brushProperty name="height" value="${heightHimetric}" units="himetric" />
        <inkml:brushProperty name="color" value="${pen.colorHex}" />
        <inkml:brushProperty name="transparency" value="${transparency}" />
        <inkml:brushProperty name="tip" value="ellipse" />
        <inkml:brushProperty name="rasterOp" value="${pen.rasterOp}" />
        <inkml:brushProperty name="ignorePressure" value="false" />
        <inkml:brushProperty name="antiAliased" value="true" />
        <inkml:brushProperty name="fitToCurve" value="false" />
    </inkml:brush>`);
  }

  parts.push('\n  </inkml:definitions>\n');
  return parts.join('');
}

interface TraceBuildState {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  widthConv: number;
  heightConv: number;
  xPad: number;
  yPad: number;
  nextTraceId: number;
  traces: string[];
}

function scaleCoordinate(
  x: number,
  y: number,
  state: TraceBuildState
): readonly [number, number] {
  let xRange = state.maxX - state.minX;
  let yRange = state.maxY - state.minY;

  if (xRange === 0) {
    xRange = 1;
  }
  if (yRange === 0) {
    yRange = 1;
  }

  const xNorm = (x - state.minX) / xRange;
  const yNorm = (y - state.minY) / yRange;

  const newX = Math.trunc(xNorm * xRange * state.widthConv + state.xPad);
  const newY = Math.trunc(yNorm * yRange * state.heightConv + state.yPad);
  return [newX, newY];
}

function appendStrokeTrace(
  line: SceneLineItem,
  moveX: number,
  moveY: number,
  state: TraceBuildState
): void {
  if (line.points.length === 0) {
    return;
  }

  const traceId = state.nextTraceId;
  state.nextTraceId += 1;

  const coords: string[] = [];
  for (const pt of line.points) {
    if (pt.x < state.minX) {
      state.minX = pt.x;
    } else if (pt.x > state.maxX) {
      state.maxX = pt.x;
    }

    if (pt.y < state.minY) {
      state.minY = pt.y;
    } else if (pt.y > state.maxY) {
      state.maxY = pt.y;
    }

    const [scaledX, scaledY] = scaleCoordinate(pt.x + moveX, pt.y + moveY, state);
    const scaledPressure = Math.trunc(pt.pressure * INKML_PRESSURE_CONV_CONSTANT);
    coords.push(`${scaledX} ${scaledY} ${scaledPressure}`);
  }

  const pen = createInkPen(line.tool, line.color, line.thicknessScale, line.colorRgba);
  const brushId = generateBrushIdFromPen(pen);

  state.traces.push(
    `    <inkml:trace xml:id="${traceId}" contextRef="#ctxCoordinatesWithPressure" ` +
      `brushRef="#${brushId}">${coords.join(',')}</inkml:trace>\n`
  );
}

function traverseGroupForTraces(
  group: SceneGroupItem,
  anchorPos: AnchorPositionMap,
  moveX: number,
  moveY: number,
  state: TraceBuildState
): void {
  for (const child of group.children.values()) {
    if (!child) {
      continue;
    }
    if (child.kind === 'group') {
      const [anchorX, anchorY] = getGroupAnchor(child, anchorPos);
      traverseGroupForTraces(child, anchorPos, moveX + anchorX, moveY + anchorY, state);
    } else if (child.kind === 'line') {
      appendStrokeTrace(child, moveX, moveY, state);
    }
  }
}

/**
 * Converts a parsed `SceneTree` into OneNote-compatible InkML XML.
 */
export function sceneTreeToInkMlXml(
  tree: SceneTree,
  options: RmConversionOptions = {}
): {
  readonly inkmlXml: string;
  readonly traceCount: number;
} {
  const pens = collectUsedPens(tree);
  const definitionsXml = renderDefinitionsXml(pens);

  const anchorPos = buildAnchorPos(tree.rootText);
  const pdfSize = options.pdfPageSizePt;
  const isLandscapePdf =
    pdfSize !== undefined &&
    pdfSize !== null &&
    pdfSize.widthPt > 0 &&
    pdfSize.heightPt > 0 &&
    pdfSize.widthPt > pdfSize.heightPt;

  let initialBox: BoundingBox;
  if (isLandscapePdf) {
    // The box must cover the whole PDF page in `.rm` units. If it were smaller
    // than the page, the leftmost stroke would widen `minX` and get pinned to
    // the page's left edge, shifting all ink horizontally.
    const rmUnitsPerPt = RM_DPI / PDF_POINTS_PER_INCH;
    const landscapeHalfWidth = Math.round((pdfSize.widthPt / 2) * rmUnitsPerPt);
    const landscapeHeight = Math.round(pdfSize.heightPt * rmUnitsPerPt);
    initialBox = getBoundingBox(tree.root, anchorPos, {
      xMin: -landscapeHalfWidth,
      xMax: landscapeHalfWidth,
      yMin: 0,
      yMax: landscapeHeight,
    });
  } else {
    initialBox = getBoundingBox(tree.root, anchorPos);
  }

  const state: TraceBuildState = {
    minX: initialBox.xMin,
    maxX: initialBox.xMax,
    minY: initialBox.yMin,
    maxY: initialBox.yMax,
    widthConv: isLandscapePdf ? INKML_LANDSCAPE_PDF_CONV_CONSTANT : INKML_WIDTH_CONV_CONSTANT,
    heightConv: isLandscapePdf ? INKML_LANDSCAPE_PDF_CONV_CONSTANT : INKML_HEIGHT_CONV_CONSTANT,
    xPad: INKML_X_PAD,
    yPad: isLandscapePdf ? INKML_LANDSCAPE_PDF_Y_PAD : INKML_Y_PAD,
    nextTraceId: 1,
    traces: [],
  };

  traverseGroupForTraces(tree.root, anchorPos, 0, 0, state);

  const inkmlXml =
    XML_HEADER +
    definitionsXml +
    '  <inkml:traceGroup>\n' +
    state.traces.join('') +
    '  </inkml:traceGroup>\n' +
    '</inkml:ink>\n';

  return {
    inkmlXml,
    traceCount: state.nextTraceId - 1,
  };
}

/**
 * Converts a parsed `SceneTree` into OneNote-compatible Presentation HTML.
 */
export function sceneTreeToPresentationHtml(
  tree: SceneTree,
  options: RmConversionOptions = {}
): {
  readonly presentationHtml: string;
  readonly paragraphCount: number;
} {
  const pageTitle = escapeHtml(options.pageTitle ?? 'Untitled Page');
  const htmlParts: string[] = [];

  htmlParts.push(`<html>
    <head>
        <title>${pageTitle}</title>
    </head>
    <body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">`);

  if (options.includeBackgroundImageRef) {
    htmlParts.push(
      '\n        <img data-render-src="name:background" style="position:absolute;top:0;left:0;z-index:-1" />'
    );
  }

  let paragraphCount = 0;
  const rootText = tree.rootText;

  if (rootText !== null) {
    const doc = buildTextDocument(rootText);
    const xOffset = 600;
    let yOffset = INKML_Y_PAD;

    for (const paragraph of doc.contents) {
      yOffset += 20;
      const xPos = Math.trunc(rootText.posX);
      const yPos = Math.trunc(rootText.posY / 2);
      const widthPx = Math.trunc(rootText.width);

      if (paragraph.plainText.length > 0 && paragraph.contents.length > 0) {
        const baseProps = paragraph.contents[0].properties;
        const pStyle = `font-weight: ${baseProps['font-weight']};font-style: ${baseProps['font-style']}`;
        const content = escapeTextWithLineBreaks(paragraph.plainText.trim());
        const divId = escapeHtml(formatCrdtId(paragraph.startId));

        htmlParts.push(
          `   \n                <div id="${divId}" style="position: absolute; left: ${xPos + xOffset}px; top: ${yPos + yOffset}px; width: ${widthPx}px">\n` +
            `                    <p style="${pStyle}">${content}</p>\n` +
            `                </div>`
        );
        yOffset += getParagraphLineHeight(paragraph.style.value) - 20;
        paragraphCount += 1;
      }
    }
  }

  htmlParts.push(`
    </body>
</html>`);

  return {
    presentationHtml: htmlParts.join(''),
    paragraphCount,
  };
}

/**
 * Converts a raw `.rm` byte buffer (v6, v5, or v3) into OneNote InkML XML and Presentation HTML.
 */
export function convertRmPage(
  rmBytes: Uint8Array,
  options: RmConversionOptions = {}
): RmConversionResult {
  const tree = parseRmSceneTree(rmBytes);
  const { inkmlXml, traceCount } = sceneTreeToInkMlXml(tree, options);
  const { presentationHtml, paragraphCount } = sceneTreeToPresentationHtml(tree, options);

  return {
    inkmlXml,
    presentationHtml,
    traceCount,
    paragraphCount,
    formatVersion: tree.formatVersion,
  };
}

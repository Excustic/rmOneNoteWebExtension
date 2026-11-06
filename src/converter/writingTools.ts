/**
 * Writing tool models and reMarkable color palette mappings for InkML export.
 *
 * Ported from `rmc/src/rmc/exporters/writing_tools.py` and `inmkl.py`, with
 * forward-compatible support for explicit `color_rgba` values introduced in
 * reMarkable firmware 3.6+ / Paper Pro.
 */

import type { RgbaColor } from './binaryReader';
import { PenColor, PenType } from './sceneItems';

export type RgbTuple = readonly [number, number, number];

export const RM_PALETTE: Readonly<Record<number, RgbTuple>> = {
  [PenColor.BLACK]: [0, 0, 0],
  [PenColor.GRAY]: [144, 144, 144],
  [PenColor.WHITE]: [255, 255, 255],
  [PenColor.YELLOW]: [251, 247, 25],
  [PenColor.GREEN]: [0, 255, 0],
  [PenColor.PINK]: [255, 192, 203],
  [PenColor.BLUE]: [78, 105, 201],
  [PenColor.RED]: [179, 62, 57],
  [PenColor.GRAY_OVERLAP]: [125, 125, 125],
  [PenColor.GREEN_2]: [161, 216, 125],
  [PenColor.CYAN]: [139, 208, 229],
  [PenColor.MAGENTA]: [183, 130, 205],
  [PenColor.YELLOW_2]: [247, 232, 81],
};

export function rgbToHex(rgb: RgbTuple): string {
  const toHexByte = (channel: number): string =>
    Math.max(0, Math.min(255, Math.round(channel)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHexByte(rgb[0])}${toHexByte(rgb[1])}${toHexByte(rgb[2])}`;
}

export interface InkPen {
  readonly name: string;
  readonly strokeLinecap: 'round' | 'square';
  readonly strokeOpacity: number;
  readonly strokeWidth: number;
  readonly colorHex: string;
  readonly colorKey: string;
  readonly rasterOp: 'maskPen' | 'copyPen';
}

function formatNumericIdSegment(value: number): string {
  if (Number.isInteger(value)) {
    // Match Python float formatting when thickness_scale came from a float vs int:
    // XML NCName allows digits and '.', so clean canonical number string is ideal.
    return String(value);
  }
  return String(Number(value.toFixed(6)));
}

export function generateBrushIdFromPen(pen: InkPen): string {
  const safeName = pen.name.replace(/\s+/g, '_');
  const widthStr = formatNumericIdSegment(pen.strokeWidth);
  const opacityStr = formatNumericIdSegment(pen.strokeOpacity);
  return `name_${safeName}_cap_${pen.strokeLinecap}_op_${opacityStr}_w_${widthStr}_clr_${pen.colorKey}`;
}

function resolveStrokeColor(
  rawColorId: number,
  colorRgba: RgbaColor | null
): { rgb: RgbTuple; colorKey: string } {
  // Eraser overrides rawColorId before calling resolveStrokeColor.
  // Dynamic highlight/shader colors (PenColor.HIGHLIGHT === 9 or future IDs) carry explicit RGBA in v3.6+.
  if ((rawColorId === PenColor.HIGHLIGHT || !(rawColorId in RM_PALETTE)) && colorRgba !== null) {
    const rgb: RgbTuple = [colorRgba[0], colorRgba[1], colorRgba[2]];
    const hexWithoutHash = rgbToHex(rgb).slice(1);
    return { rgb, colorKey: `rgba_${hexWithoutHash}` };
  }

  if (rawColorId === PenColor.HIGHLIGHT) {
    const yellow = RM_PALETTE[PenColor.YELLOW];
    return { rgb: yellow, colorKey: String(PenColor.YELLOW) };
  }

  const mapped = RM_PALETTE[rawColorId];
  if (mapped) {
    return { rgb: mapped, colorKey: String(rawColorId) };
  }

  return { rgb: RM_PALETTE[PenColor.BLACK], colorKey: String(PenColor.BLACK) };
}

export function createInkPen(
  toolId: number,
  rawColorId: number,
  thicknessScale: number,
  colorRgba: RgbaColor | null = null
): InkPen {
  const effectiveColorId = toolId === PenType.ERASER ? PenColor.WHITE : rawColorId;
  const effectiveRgba = toolId === PenType.ERASER ? null : colorRgba;
  const { rgb, colorKey } = resolveStrokeColor(effectiveColorId, effectiveRgba);
  const colorHex = rgbToHex(rgb);

  switch (toolId) {
    case PenType.PAINTBRUSH_1:
    case PenType.PAINTBRUSH_2:
      return {
        name: 'Brush',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.CALIGRAPHY:
    case PenType.CALLIGRAPHY_LEGACY:
      return {
        name: 'Calligraphy',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.MARKER_1:
    case PenType.MARKER_2:
      return {
        name: 'Marker',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.BALLPOINT_1:
    case PenType.BALLPOINT_2:
      return {
        name: 'Ballpoint',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.FINELINER_1:
    case PenType.FINELINER_2:
      return {
        name: 'Fineliner',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale * 1.8,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.PENCIL_1:
    case PenType.PENCIL_2:
      return {
        name: 'Pencil',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.MECHANICAL_PENCIL_1:
    case PenType.MECHANICAL_PENCIL_2:
      return {
        name: 'Mechanical_Pencil',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale ** 2,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.HIGHLIGHTER_1:
    case PenType.HIGHLIGHTER_2:
      return {
        name: 'Highlighter',
        strokeLinecap: 'square',
        strokeOpacity: 0.2,
        strokeWidth: 15,
        colorHex,
        colorKey,
        rasterOp: 'maskPen',
      };

    case PenType.SHADER:
      return {
        name: 'Shader',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: 12,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.ERASER:
      return {
        name: 'Eraser',
        strokeLinecap: 'square',
        strokeOpacity: 1,
        strokeWidth: thicknessScale * 2,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    case PenType.ERASER_AREA:
      return {
        name: 'Erase_Area',
        strokeLinecap: 'square',
        strokeOpacity: 1,
        strokeWidth: thicknessScale,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };

    default:
      return {
        name: 'Fineliner',
        strokeLinecap: 'round',
        strokeOpacity: 1,
        strokeWidth: thicknessScale * 1.8,
        colorHex,
        colorKey,
        rasterOp: 'copyPen',
      };
  }
}

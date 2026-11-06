import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveRemarkableAuth } from '../auth/authStore';
import { resetMockBrowserStorage } from './setup';
import {
  convertRmPage,
  crdtId,
  CrdtSequence,
  downloadAndConvertRmPage,
  END_MARKER,
  ParagraphStyle,
  PenColor,
  PenType,
  readRmV6Blocks,
  RM_HEADER_V3,
  RM_HEADER_V5,
  RM_HEADER_V6,
  ROOT_ID,
  TagType,
} from '../converter';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const ASCII_ENCODER = new TextEncoder();

/**
 * Minimal v6 binary writer used to synthesize authentic `.rm` v6 test pages.
 */
class V6TestWriter {
  private readonly bytes: number[] = [];

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  writeRaw(chunk: Uint8Array): void {
    for (const b of chunk) {
      this.bytes.push(b);
    }
  }

  writeUint8(val: number): void {
    this.bytes.push(val & 0xff);
  }

  writeBool(val: boolean): void {
    this.writeUint8(val ? 1 : 0);
  }

  writeUint16(val: number): void {
    const buf = new ArrayBuffer(2);
    new DataView(buf).setUint16(0, val, true);
    this.writeRaw(new Uint8Array(buf));
  }

  writeUint32(val: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, val >>> 0, true);
    this.writeRaw(new Uint8Array(buf));
  }

  writeFloat32(val: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, val, true);
    this.writeRaw(new Uint8Array(buf));
  }

  writeFloat64(val: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val, true);
    this.writeRaw(new Uint8Array(buf));
  }

  writeVaruint(value: number | bigint): void {
    let v = typeof value === 'bigint' ? value : BigInt(value);
    while (true) {
      const low = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) {
        this.writeUint8(low | 0x80);
      } else {
        this.writeUint8(low);
        break;
      }
    }
  }

  writeCrdtId(part1: number, part2: number | bigint): void {
    this.writeUint8(part1);
    this.writeVaruint(part2);
  }

  writeTag(index: number, tagType: TagType): void {
    this.writeVaruint((BigInt(index) << 4n) | BigInt(tagType));
  }

  writeTaggedId(index: number, part1: number, part2: number | bigint): void {
    this.writeTag(index, TagType.ID);
    this.writeCrdtId(part1, part2);
  }

  writeTaggedBool(index: number, val: boolean): void {
    this.writeTag(index, TagType.Byte1);
    this.writeBool(val);
  }

  writeTaggedByte(index: number, val: number): void {
    this.writeTag(index, TagType.Byte1);
    this.writeUint8(val);
  }

  writeTaggedInt(index: number, val: number): void {
    this.writeTag(index, TagType.Byte4);
    this.writeUint32(val);
  }

  writeTaggedFloat(index: number, val: number): void {
    this.writeTag(index, TagType.Byte4);
    this.writeFloat32(val);
  }

  writeTaggedDouble(index: number, val: number): void {
    this.writeTag(index, TagType.Byte8);
    this.writeFloat64(val);
  }

  writeSubblock(index: number, buildFn: (sub: V6TestWriter) => void): void {
    const sub = new V6TestWriter();
    buildFn(sub);
    const payload = sub.toUint8Array();
    this.writeTag(index, TagType.Length4);
    this.writeUint32(payload.byteLength);
    this.writeRaw(payload);
  }

  writeLwwString(index: number, str: string): void {
    this.writeSubblock(index, (sub) => {
      sub.writeTaggedId(1, 0, 1n);
      sub.writeSubblock(2, (s2) => {
        const encoded = ASCII_ENCODER.encode(str);
        s2.writeVaruint(encoded.byteLength);
        s2.writeBool(true);
        s2.writeRaw(encoded);
      });
    });
  }

  writeLwwBool(index: number, val: boolean): void {
    this.writeSubblock(index, (sub) => {
      sub.writeTaggedId(1, 0, 1n);
      sub.writeTaggedBool(2, val);
    });
  }

  writeLwwId(index: number, part1: number, part2: number | bigint): void {
    this.writeSubblock(index, (sub) => {
      sub.writeTaggedId(1, 0, 1n);
      sub.writeTaggedId(2, part1, part2);
    });
  }

  writeLwwByte(index: number, val: number): void {
    this.writeSubblock(index, (sub) => {
      sub.writeTaggedId(1, 0, 1n);
      sub.writeTaggedByte(2, val);
    });
  }

  writeLwwFloat(index: number, val: number): void {
    this.writeSubblock(index, (sub) => {
      sub.writeTaggedId(1, 0, 1n);
      sub.writeTaggedFloat(2, val);
    });
  }

  writeMainBlock(
    blockType: number,
    minVersion: number,
    currentVersion: number,
    buildFn: (body: V6TestWriter) => void
  ): void {
    const body = new V6TestWriter();
    buildFn(body);
    const payload = body.toUint8Array();
    this.writeUint32(payload.byteLength);
    this.writeUint8(0);
    this.writeUint8(minVersion);
    this.writeUint8(currentVersion);
    this.writeUint8(blockType);
    this.writeRaw(payload);
  }
}

describe('Phase 5: Native TypeScript .rm to InkML + HTML Converter', () => {
  beforeEach(() => {
    resetMockBrowserStorage();
  });

  it('parses upstream rmscene v6 binary vectors, preserves unknown extra bytes, and isolates corrupt blocks', () => {
    const header = ASCII_ENCODER.encode(RM_HEADER_V6);

    // 1. MigrationInfoBlock vector from rmscene test_write_blocks
    const migrationBytes = concatBytes(header, hexToBytes('05000000000101001f01012101'));
    const migrationBlocks = readRmV6Blocks(migrationBytes);
    expect(migrationBlocks).toHaveLength(1);
    expect(migrationBlocks[0]).toMatchObject({
      kind: 'migration_info',
      migrationId: crdtId(1, 1n),
      isDevice: true,
    });

    // 2. SceneInfo with unknown trailing bytes (E1 FF) from test_blocks_keep_unknown_data_in_main_block
    const sceneInfoHex = `
      2E000000 0000010D
      1C 06000000
         1F 0000
         2F 0000
      2C 05000000
         1F 0000 21 01
      3C 05000000
         1F 0000 21 01
      5C 08000000
         7C050000 50070000
      E1 FF
    `;
    const sceneInfoBlocks = readRmV6Blocks(concatBytes(header, hexToBytes(sceneInfoHex)));
    expect(sceneInfoBlocks).toHaveLength(1);
    expect(sceneInfoBlocks[0].kind).toBe('scene_info');
    if (sceneInfoBlocks[0].kind === 'scene_info') {
      expect(sceneInfoBlocks[0].info.paperSize).toEqual([1404, 1872]);
      expect( Array.from(sceneInfoBlocks[0].extraData) ).toEqual([0xe1, 0xff]);
    }

    // 3. SceneLineItemBlock v2 with extra subblock bytes (8f 0101) from test_blocks_keep_unknown_data_in_value_subblock
    const lineHex = `
      59000000 00020205
      1f 0219
      2f 021e
      3f 0000
      4f 0000
      54 0000 0000
      6c 4300 0000
         03
         14 0f000000
         24 00000000
         38 00000000 0000f03f
         44 00000000
         5c 1c000000
            f8fe82c2 f42a30c3 03000800 0000b869
            83c2622d 30c30000 08000000
         6f 0001
         7f 010f
         8f 0101
    `;
    const lineBlocks = readRmV6Blocks(concatBytes(header, hexToBytes(lineHex)));
    expect(lineBlocks).toHaveLength(1);
    expect(lineBlocks[0].kind).toBe('scene_line_item');
    if (lineBlocks[0].kind === 'scene_line_item' && lineBlocks[0].item.value?.kind === 'line') {
      const line = lineBlocks[0].item.value;
      expect(line.tool).toBe(PenType.BALLPOINT_2);
      expect(line.color).toBe(PenColor.BLACK);
      expect(line.thicknessScale).toBe(1.0);
      expect(line.points).toHaveLength(2);
      expect(line.moveId).toEqual(crdtId(1, 15n));
      expect(Array.from(lineBlocks[0].extraValueData)).toEqual([0x8f, 0x01, 0x01]);
    }

    // 4. Error containment across blocks from test_error_in_block_contained
    const containedHex = `
      06000000 00010103
      1f 0219
      aa bbcc
      05000000 00010100
      1f 0219
      21 01
    `;
    const containedBlocks = readRmV6Blocks(concatBytes(header, hexToBytes(containedHex)));
    expect(containedBlocks).toHaveLength(2);
    expect(containedBlocks[0].kind).toBe('unreadable');
    expect(containedBlocks[1]).toMatchObject({
      kind: 'migration_info',
      migrationId: crdtId(0x02, 0x19n),
      isDevice: true,
    });
  });

  it('sorts concurrent CRDT sequence items deterministically by higher author ID then lower counter', () => {
    const seq = new CrdtSequence<string>([
      {
        itemId: crdtId(1, 10n),
        leftId: END_MARKER,
        rightId: END_MARKER,
        deletedLength: 0,
        value: 'author1-early',
      },
      {
        itemId: crdtId(2, 50n),
        leftId: END_MARKER,
        rightId: END_MARKER,
        deletedLength: 0,
        value: 'author2-wins-concurrent-tie',
      },
      {
        itemId: crdtId(1, 11n),
        leftId: crdtId(1, 10n),
        rightId: END_MARKER,
        deletedLength: 0,
        value: 'after-author1',
      },
    ]);

    expect(seq.values()).toEqual([
      'author2-wins-concurrent-tie',
      'author1-early',
      'after-author1',
    ]);
  });

  it('converts a full v6 page with strokes, 48-bit anchored group, highlight RGBA, and formatted text into InkML + HTML', () => {
    const w = new V6TestWriter();
    w.writeRaw(ASCII_ENCODER.encode(RM_HEADER_V6));

    // SceneTreeBlock: Layer 1 (0, 11) under ROOT (0, 1)
    w.writeMainBlock(0x01, 1, 1, (b) => {
      b.writeTaggedId(1, 0, 11n);
      b.writeTaggedId(2, 0, 0n);
      b.writeTaggedBool(3, true);
      b.writeSubblock(4, (sub) => sub.writeTaggedId(1, 0, 1n));
    });

    // RootTextBlock: "Math: x < y & z > 0\nBold line" with inline bold formatting code 1
    w.writeMainBlock(0x07, 1, 1, (b) => {
      b.writeTaggedId(1, 0, 0n);
      b.writeSubblock(2, (s2) => {
        // Text items
        s2.writeSubblock(1, (t1) =>
          t1.writeSubblock(1, (t2) => {
            t2.writeVaruint(3);
            // Item 1: first line + newline
            const line1 = 'Math: x < y & z > 0\u2028ok\n';
            const line1Bytes = ASCII_ENCODER.encode(line1);
            const line1Len = Array.from(line1).length;
            t2.writeSubblock(0, (item) => {
              item.writeTaggedId(2, 1, 100n);
              item.writeTaggedId(3, 0, 0n);
              item.writeTaggedId(4, 0, 0n);
              item.writeTaggedInt(5, 0);
              item.writeSubblock(6, (strSub) => {
                strSub.writeVaruint(line1Bytes.byteLength);
                strSub.writeBool(true);
                strSub.writeRaw(line1Bytes);
              });
            });
            // Item 2: inline bold format code (1) after newline char (1, 100 + line1Len - 1)
            const newlineCharId = BigInt(100 + line1Len - 1);
            t2.writeSubblock(0, (item) => {
              item.writeTaggedId(2, 1, 200n);
              item.writeTaggedId(3, 1, newlineCharId);
              item.writeTaggedId(4, 0, 0n);
              item.writeTaggedInt(5, 0);
              item.writeSubblock(6, (strSub) => {
                strSub.writeVaruint(0);
                strSub.writeBool(true);
                strSub.writeTaggedInt(2, 1); // format code 1 = bold
              });
            });
            // Item 3: "Second paragraph"
            const line2Bytes = ASCII_ENCODER.encode('Second paragraph');
            t2.writeSubblock(0, (item) => {
              item.writeTaggedId(2, 1, 201n);
              item.writeTaggedId(3, 1, 200n);
              item.writeTaggedId(4, 0, 0n);
              item.writeTaggedInt(5, 0);
              item.writeSubblock(6, (strSub) => {
                strSub.writeVaruint(line2Bytes.byteLength);
                strSub.writeBool(true);
                strSub.writeRaw(line2Bytes);
              });
            });
          })
        );

        // Styles
        s2.writeSubblock(2, (f1) =>
          f1.writeSubblock(1, (f2) => {
            f2.writeVaruint(1);
            f2.writeCrdtId(0, 0n);
            f2.writeTaggedId(1, 1, 15n);
            f2.writeSubblock(2, (st) => {
              st.writeUint8(17);
              st.writeUint8(ParagraphStyle.HEADING);
            });
          })
        );
      });

      b.writeSubblock(3, (pos) => {
        pos.writeFloat64(-468.0);
        pos.writeFloat64(234.0);
      });
      b.writeTaggedFloat(4, 936.0);
    });

    // TreeNodeBlock for ROOT (0, 1)
    w.writeMainBlock(0x02, 1, 1, (b) => {
      b.writeTaggedId(1, 0, 1n);
      b.writeLwwString(2, '');
      b.writeLwwBool(3, true);
    });

    // TreeNodeBlock for Layer 1 (0, 11) anchored to special 48-bit top anchor 0xfffffffffffe (281474976710654 -> y=100)
    w.writeMainBlock(0x02, 1, 2, (b) => {
      b.writeTaggedId(1, 0, 11n);
      b.writeLwwString(2, 'Layer 1');
      b.writeLwwBool(3, true);
      b.writeLwwId(7, 0, 281474976710654n);
      b.writeLwwByte(8, 0);
      b.writeLwwFloat(9, 0);
      b.writeLwwFloat(10, 50); // anchorOriginX = 50
    });

    // SceneGroupItemBlock attaching Layer 1 under ROOT
    w.writeMainBlock(0x04, 1, 1, (b) => {
      b.writeTaggedId(1, ROOT_ID.part1, ROOT_ID.part2);
      b.writeTaggedId(2, 0, 13n);
      b.writeTaggedId(3, 0, 0n);
      b.writeTaggedId(4, 0, 0n);
      b.writeTaggedInt(5, 0);
      b.writeSubblock(6, (sub) => {
        sub.writeUint8(0x02);
        sub.writeTaggedId(2, 0, 11n);
      });
    });

    // Helper to append a v2 SceneLineItemBlock to Layer 1
    const appendLine = (
      itemCounter: bigint,
      leftCounter: bigint,
      tool: PenType,
      color: PenColor,
      thicknessScale: number,
      points: Array<{ x: number; y: number; pressure: number }>,
      packedBgra?: number
    ): void => {
      w.writeMainBlock(0x05, 2, 2, (b) => {
        b.writeTaggedId(1, 0, 11n);
        b.writeTaggedId(2, 1, itemCounter);
        b.writeTaggedId(3, leftCounter === 0n ? 0 : 1, leftCounter);
        b.writeTaggedId(4, 0, 0n);
        b.writeTaggedInt(5, 0);
        b.writeSubblock(6, (sub) => {
          sub.writeUint8(0x03);
          sub.writeTaggedInt(1, tool);
          sub.writeTaggedInt(2, color);
          sub.writeTaggedDouble(3, thicknessScale);
          sub.writeTaggedFloat(4, 0);
          sub.writeSubblock(5, (pts) => {
            for (const pt of points) {
              pts.writeFloat32(pt.x);
              pts.writeFloat32(pt.y);
              pts.writeUint16(10); // speed
              pts.writeUint16(8); // width
              pts.writeUint8(0); // direction
              pts.writeUint8(pt.pressure);
            }
          });
          sub.writeTaggedId(6, 0, 1n);
          if (packedBgra !== undefined) {
            sub.writeTaggedInt(8, packedBgra);
          }
        });
      });
    };

    // Stroke 1: Blue Fineliner
    appendLine(301n, 0n, PenType.FINELINER_2, PenColor.BLUE, 2.0, [
      { x: 0, y: 100, pressure: 100 },
      { x: 100, y: 200, pressure: 200 },
    ]);

    // Stroke 2: Legacy Highlighter (color=9 without RGBA -> falls back to Yellow #fbf719, maskPen, transparency 0.8)
    appendLine(302n, 301n, PenType.HIGHLIGHTER_2, PenColor.HIGHLIGHT, 1.0, [
      { x: -50, y: 120, pressure: 128 },
    ]);

    // Stroke 3: Modern OS 3.6+ Highlighter with explicit RGBA (R=255, G=128, B=64, A=200 -> BGRA 0xC8FF8040)
    appendLine(
      303n,
      302n,
      PenType.HIGHLIGHTER_2,
      PenColor.HIGHLIGHT,
      1.0,
      [{ x: -20, y: 140, pressure: 255 }],
      0xc8ff8040
    );

    // Stroke 4: Mechanical Pencil (verifies space-free XML NCName xml:id)
    appendLine(304n, 303n, PenType.MECHANICAL_PENCIL_2, PenColor.BLACK, 2.0, [
      { x: 10, y: 150, pressure: 64 },
    ]);

    const rmBytes = w.toUint8Array();
    const result = convertRmPage(rmBytes, { pageTitle: 'Calculus 1 - Lecture <1>' });

    expect(result.formatVersion).toBe(6);
    expect(result.traceCount).toBe(4);
    expect(result.paragraphCount).toBe(2);

    // Verify InkML header, context, brushes, and traces
    expect(result.inkmlXml).toContain('<inkml:context xml:id="ctxCoordinatesWithPressure">');
    expect(result.inkmlXml).toContain(
      '<inkml:brush xml:id="name_Fineliner_cap_round_op_1_w_3.6_clr_6">'
    );
    expect(result.inkmlXml).toContain('<inkml:brushProperty name="color" value="#4e69c9" />');
    expect(result.inkmlXml).toContain('<inkml:brushProperty name="width" value="36" units="himetric" />');

    // Legacy highlighter -> Yellow #fbf719 + maskPen + transparency 0.8
    expect(result.inkmlXml).toContain(
      '<inkml:brush xml:id="name_Highlighter_cap_square_op_0.2_w_15_clr_3">'
    );
    expect(result.inkmlXml).toContain('<inkml:brushProperty name="color" value="#fbf719" />');
    expect(result.inkmlXml).toContain('<inkml:brushProperty name="transparency" value="0.8" />');
    expect(result.inkmlXml).toContain('<inkml:brushProperty name="rasterOp" value="maskPen" />');

    // Dynamic RGBA highlighter -> #ff8040
    expect(result.inkmlXml).toContain(
      '<inkml:brush xml:id="name_Highlighter_cap_square_op_0.2_w_15_clr_rgba_ff8040">'
    );
    expect(result.inkmlXml).toContain('<inkml:brushProperty name="color" value="#ff8040" />');

    // Mechanical_Pencil has no invalid XML ID spaces
    expect(result.inkmlXml).toContain(
      '<inkml:brush xml:id="name_Mechanical_Pencil_cap_round_op_1_w_4_clr_0">'
    );

    // Verify 48-bit anchor offset (anchorOriginX=50, anchorY=100; default minX=-702, minY=0)
    // Stroke 1 pt 1: worldX = 0 + 50 = 50 -> (50 - (-702)) * 10 = 7520
    //                worldY = 100 + 100 = 200 -> (200 - 0) * 10 + 600 = 2600
    //                pressure = 100 * 128 = 12800
    expect(result.inkmlXml).toContain(
      '<inkml:trace xml:id="1" contextRef="#ctxCoordinatesWithPressure" brushRef="#name_Fineliner_cap_round_op_1_w_3.6_clr_6">7520 2600 12800,8520 3600 25600</inkml:trace>'
    );

    // Verify Presentation HTML escaping, title, line breaks, and bold formatting
    expect(result.presentationHtml).toContain('<title>Calculus 1 - Lecture &lt;1&gt;</title>');
    expect(result.presentationHtml).toContain('data-absolute-enabled="true"');
    expect(result.presentationHtml).toContain('Math: x &lt; y &amp; z &gt; 0<br>ok');
    expect(result.presentationHtml).toContain(
      '<p style="font-weight: bold;font-style: normal">Second paragraph</p>'
    );

    // Verify statelessness on repeated invocation (trace xml:id resets to 1)
    const secondRun = convertRmPage(rmBytes, { pageTitle: 'Second Run' });
    expect(secondRun.traceCount).toBe(4);
    expect(secondRun.inkmlXml).toContain('<inkml:trace xml:id="1"');
    expect(secondRun.inkmlXml).not.toContain('<inkml:trace xml:id="5"');
  });

  it('parses legacy v3 and v5 .rm binary pages and converts black-default highlighters to yellow', () => {
    const buildLegacyRm = (version: 3 | 5): Uint8Array => {
      const header = ASCII_ENCODER.encode(version === 3 ? RM_HEADER_V3 : RM_HEADER_V5);
      const body = new V6TestWriter();
      body.writeUint32(1); // 1 layer
      body.writeUint32(1); // 1 stroke
      body.writeUint32(PenType.HIGHLIGHTER_1); // brush type 5
      body.writeUint32(PenColor.BLACK); // legacy v3/v5 black-default highlight color
      body.writeUint32(0); // padding
      body.writeFloat32(2.0); // brush size
      if (version === 5) {
        body.writeFloat32(0.0); // v5 extra float32
      }
      body.writeUint32(1); // 1 point
      body.writeFloat32(702.0); // center of 1404px screen -> v6 x = 0
      body.writeFloat32(100.0); // y = 100
      body.writeFloat32(1.0); // speed
      body.writeFloat32(0.0); // direction
      body.writeFloat32(2.0); // width
      body.writeFloat32(0.5); // pressure [0..1] -> 127.5 * 128 = 16320

      return concatBytes(header, body.toUint8Array());
    };

    const v3Result = convertRmPage(buildLegacyRm(3), { pageTitle: 'Legacy V3' });
    expect(v3Result.formatVersion).toBe(3);
    expect(v3Result.traceCount).toBe(1);
    expect(v3Result.inkmlXml).toContain('<inkml:brushProperty name="color" value="#fbf719" />');
    // x = 0 -> (0 - (-702)) * 10 = 7020; y = 100 -> 100 * 10 + 600 = 1600; pressure = 0.5 * 255 * 128 = 16320
    expect(v3Result.inkmlXml).toContain('7020 1600 16320</inkml:trace>');

    const v5Result = convertRmPage(buildLegacyRm(5), { pageTitle: 'Legacy V5' });
    expect(v5Result.formatVersion).toBe(5);
    expect(v5Result.traceCount).toBe(1);
    expect(v5Result.inkmlXml).toContain('7020 1600 16320</inkml:trace>');
  });

  it('downloads a .rm page via Sync15 in memory and injects optional PDF background image HTML', async () => {
    await saveRemarkableAuth({
      deviceId: 'dev-123',
      deviceToken: 'dev-token',
      userToken: 'user-token',
      userTokenExpiresAtMs: Date.now() + 3_600_000,
      pairedAt: new Date().toISOString(),
    });

    const w = new V6TestWriter();
    w.writeRaw(ASCII_ENCODER.encode(RM_HEADER_V6));
    const emptyV6Bytes = w.toUint8Array();

    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(emptyV6Bytes.buffer.slice(0) as ArrayBuffer, { status: 200 });
    });

    const converted = await downloadAndConvertRmPage('doc-123', 'page-456', {
      knownBlobHash: 'a'.repeat(64),
      fetchImpl: mockFetch,
      pageTitle: 'Annotated PDF Page 1',
      includeBackgroundImageRef: true,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(converted.traceCount).toBe(0);
    expect(converted.presentationHtml).toContain('<title>Annotated PDF Page 1</title>');
    expect(converted.presentationHtml).toContain(
      '<img data-render-src="name:background" style="position:absolute;top:0;left:0;z-index:-1" />'
    );
  });
});

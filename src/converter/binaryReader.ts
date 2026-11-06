/**
 * Little-endian binary stream and v6 tagged-block reader for reMarkable `.rm` files.
 *
 * Implements the binary wire specification documented in `ricklupton/rmscene`
 * (`tagged_block_common.py` and `tagged_block_reader.py`) plus header detection
 * for legacy `.rm` v3 and v5 stroke streams.
 *
 * Note on 64-bit integers:
 * JavaScript bitwise operators truncate operands to 32-bit signed integers, whereas
 * reMarkable CRDT IDs use up to 64-bit `part2` counters (for example, special text
 * anchor IDs `0xfffffffffffe` = `281474976710654`). All varuint decoding therefore
 * uses `BigInt` arithmetic so 48-bit and 64-bit CRDT identifiers never overflow.
 */

export const RM_HEADER_V3 = 'reMarkable .lines file, version=3          ';
export const RM_HEADER_V5 = 'reMarkable .lines file, version=5          ';
export const RM_HEADER_V6 = 'reMarkable .lines file, version=6          ';
export const RM_HEADER_LENGTH = 43;

export type RmFormatVersion = 3 | 5 | 6;

export enum TagType {
  ID = 0xf,
  Length4 = 0xc,
  Byte8 = 0x8,
  Byte4 = 0x4,
  Byte1 = 0x1,
}

export interface CrdtId {
  readonly part1: number;
  readonly part2: bigint;
}

export interface LwwValue<T> {
  readonly timestamp: CrdtId;
  readonly value: T;
}

export type RgbaColor = readonly [number, number, number, number];

export function crdtId(part1: number, part2: number | bigint): CrdtId {
  return {
    part1,
    part2: typeof part2 === 'bigint' ? part2 : BigInt(part2),
  };
}

export function crdtIdKey(id: CrdtId): string {
  return `${id.part1}:${id.part2.toString()}`;
}

export function crdtIdEquals(a: CrdtId, b: CrdtId): boolean {
  return a.part1 === b.part1 && a.part2 === b.part2;
}

export function formatCrdtId(id: CrdtId): string {
  return `CrdtId(${id.part1}, ${id.part2.toString()})`;
}

export const END_MARKER: CrdtId = crdtId(0, 0n);
export const ROOT_ID: CrdtId = crdtId(0, 1n);

export class RmEofError extends Error {
  constructor(message = 'Unexpected end of reMarkable binary stream.') {
    super(message);
    this.name = 'RmEofError';
  }
}

export class UnexpectedBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedBlockError';
  }
}

export class BlockOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockOverflowError';
  }
}

export interface BlockInfo {
  readonly offset: number;
  readonly size: number;
  extraData: Uint8Array;
}

export interface MainBlockInfo extends BlockInfo {
  readonly blockType: number;
  readonly minVersion: number;
  readonly currentVersion: number;
}

export type SubBlockInfo = BlockInfo;

const ASCII_DECODER = new TextDecoder('ascii');
const UTF8_DECODER = new TextDecoder('utf-8');

function isTagType(raw: number): raw is TagType {
  return (
    raw === TagType.ID ||
    raw === TagType.Length4 ||
    raw === TagType.Byte8 ||
    raw === TagType.Byte4 ||
    raw === TagType.Byte1
  );
}

export class RmDataStream {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private position = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  tell(): number {
    return this.position;
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.byteLength) {
      throw new RangeError(`Cannot seek to ${offset} outside buffer length ${this.bytes.byteLength}.`);
    }
    this.position = offset;
  }

  remaining(): number {
    return this.bytes.byteLength - this.position;
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || this.position + length > this.bytes.byteLength) {
      throw new RmEofError(
        `Requested ${length} bytes at offset ${this.position}, only ${this.remaining()} available.`
      );
    }
    const slice = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  readHeaderVersion(): RmFormatVersion {
    if (this.remaining() < RM_HEADER_LENGTH) {
      throw new Error(
        `Invalid reMarkable .rm file: expected ${RM_HEADER_LENGTH}-byte header, got ${this.remaining()} bytes.`
      );
    }
    const headerBytes = this.readBytes(RM_HEADER_LENGTH);
    const header = ASCII_DECODER.decode(headerBytes);
    if (header === RM_HEADER_V6) {
      return 6;
    }
    if (header === RM_HEADER_V5) {
      return 5;
    }
    if (header === RM_HEADER_V3) {
      return 3;
    }
    throw new Error(`Unsupported or malformed reMarkable .rm header: ${JSON.stringify(header)}`);
  }

  readBool(): boolean {
    return this.readUint8() !== 0;
  }

  readUint8(): number {
    if (this.position + 1 > this.bytes.byteLength) {
      throw new RmEofError();
    }
    const value = this.view.getUint8(this.position);
    this.position += 1;
    return value;
  }

  readUint16(): number {
    if (this.position + 2 > this.bytes.byteLength) {
      throw new RmEofError();
    }
    const value = this.view.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  readUint32(): number {
    if (this.position + 4 > this.bytes.byteLength) {
      throw new RmEofError();
    }
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  readFloat32(): number {
    if (this.position + 4 > this.bytes.byteLength) {
      throw new RmEofError();
    }
    const value = this.view.getFloat32(this.position, true);
    this.position += 4;
    return value;
  }

  readFloat64(): number {
    if (this.position + 8 > this.bytes.byteLength) {
      throw new RmEofError();
    }
    const value = this.view.getFloat64(this.position, true);
    this.position += 8;
    return value;
  }

  readVaruintBigInt(): bigint {
    let shift = 0n;
    let result = 0n;
    while (true) {
      const byte = this.readUint8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        return result;
      }
      if (shift > 70n) {
        throw new Error(`Varuint exceeded 64-bit integer bounds at position ${this.position}.`);
      }
    }
  }

  readVaruint(): number {
    const big = this.readVaruintBigInt();
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`Varuint ${big.toString()} exceeds Number.MAX_SAFE_INTEGER.`);
    }
    return Number(big);
  }

  readCrdtId(): CrdtId {
    const part1 = this.readUint8();
    const part2 = this.readVaruintBigInt();
    return crdtId(part1, part2);
  }

  readTagValues(): { index: number; tagType: TagType } {
    const raw = this.readVaruintBigInt();
    const index = Number(raw >> 4n);
    const rawTagType = Number(raw & 0xfn);
    if (!isTagType(rawTagType)) {
      throw new Error(`Bad tag type 0x${rawTagType.toString(16).toUpperCase()} at position ${this.position}`);
    }
    return { index, tagType: rawTagType };
  }

  checkTag(expectedIndex: number, expectedType: TagType): boolean {
    const savedPos = this.position;
    try {
      const { index, tagType } = this.readTagValues();
      return index === expectedIndex && tagType === expectedType;
    } catch {
      return false;
    } finally {
      this.position = savedPos;
    }
  }

  readTag(expectedIndex: number, expectedType: TagType): { index: number; tagType: TagType } {
    const savedPos = this.position;
    const { index, tagType } = this.readTagValues();
    if (index !== expectedIndex) {
      this.position = savedPos;
      throw new UnexpectedBlockError(
        `Expected index ${expectedIndex}, got ${index}, at position ${savedPos}`
      );
    }
    if (tagType !== expectedType) {
      this.position = savedPos;
      throw new UnexpectedBlockError(
        `Expected tag type 0x${expectedType.toString(16).toUpperCase()}, got 0x${tagType.toString(16).toUpperCase()} at position ${savedPos}`
      );
    }
    return { index, tagType };
  }
}

export class TaggedBlockReader {
  readonly data: RmDataStream;
  currentBlock: MainBlockInfo | null = null;
  private readonly scopeStack: BlockInfo[] = [];

  constructor(bytes: Uint8Array) {
    this.data = new RmDataStream(bytes);
  }

  readHeader(): void {
    const version = this.data.readHeaderVersion();
    if (version !== 6) {
      throw new Error(`TaggedBlockReader requires a v6 .rm stream, got v${version}.`);
    }
  }

  bytesRemainingInBlock(): number {
    if (!this.currentBlock) {
      throw new Error('Not currently reading inside a top-level block.');
    }
    return this.currentBlock.offset + this.currentBlock.size - this.data.tell();
  }

  bytesRemainingInCurrentScope(): number {
    const top = this.scopeStack[this.scopeStack.length - 1];
    if (!top) {
      return this.data.remaining();
    }
    return top.offset + top.size - this.data.tell();
  }

  checkTagInScope(expectedIndex: number, expectedType: TagType): boolean {
    if (this.bytesRemainingInCurrentScope() <= 0) {
      return false;
    }
    return this.data.checkTag(expectedIndex, expectedType);
  }

  hasSubblock(index: number): boolean {
    return this.checkTagInScope(index, TagType.Length4);
  }

  readId(index: number): CrdtId {
    this.data.readTag(index, TagType.ID);
    return this.data.readCrdtId();
  }

  readBool(index: number): boolean {
    this.data.readTag(index, TagType.Byte1);
    return this.data.readBool();
  }

  readByte(index: number): number {
    this.data.readTag(index, TagType.Byte1);
    return this.data.readUint8();
  }

  readInt(index: number): number {
    this.data.readTag(index, TagType.Byte4);
    return this.data.readUint32();
  }

  readFloat(index: number): number {
    this.data.readTag(index, TagType.Byte4);
    return this.data.readFloat32();
  }

  readDouble(index: number): number {
    this.data.readTag(index, TagType.Byte8);
    return this.data.readFloat64();
  }

  private readOptional<T>(readerFn: (idx: number) => T, index: number, fallback: T): T {
    if (this.bytesRemainingInCurrentScope() <= 0) {
      return fallback;
    }
    try {
      return readerFn(index);
    } catch (err) {
      if (err instanceof UnexpectedBlockError || err instanceof RmEofError) {
        return fallback;
      }
      throw err;
    }
  }

  readIdOptional(index: number): CrdtId | null {
    return this.readOptional((i) => this.readId(i), index, null);
  }

  readBoolOptional(index: number): boolean | null {
    return this.readOptional((i) => this.readBool(i), index, null);
  }

  readByteOptional(index: number): number | null {
    return this.readOptional((i) => this.readByte(i), index, null);
  }

  readIntOptional(index: number): number | null {
    return this.readOptional((i) => this.readInt(i), index, null);
  }

  readFloatOptional(index: number): number | null {
    return this.readOptional((i) => this.readFloat(i), index, null);
  }

  readDoubleOptional(index: number): number | null {
    return this.readOptional((i) => this.readDouble(i), index, null);
  }

  /**
   * Reads an optional tagged RGBA color packed as a little-endian uint32 (stored BGRA).
   */
  readColorOptional(index: number): RgbaColor | null {
    if (!this.checkTagInScope(index, TagType.Byte4)) {
      return null;
    }
    const packed = this.readInt(index);
    return [
      (packed >>> 16) & 0xff,
      (packed >>> 8) & 0xff,
      packed & 0xff,
      (packed >>> 24) & 0xff,
    ];
  }

  /**
   * Reads the next top-level block header and runs `callback`.
   * Returns `null` when at clean EOF.
   */
  readBlock<T>(callback: (blockInfo: MainBlockInfo) => T): T | null {
    if (this.currentBlock !== null) {
      throw new UnexpectedBlockError('Already inside a top-level block.');
    }
    if (this.data.remaining() === 0) {
      return null;
    }

    let blockLength: number;
    try {
      blockLength = this.data.readUint32();
    } catch (err) {
      if (err instanceof RmEofError) {
        return null;
      }
      throw err;
    }

    const unknown = this.data.readUint8();
    const minVersion = this.data.readUint8();
    const currentVersion = this.data.readUint8();
    const blockType = this.data.readUint8();

    if (unknown !== 0 || minVersion > currentVersion) {
      throw new UnexpectedBlockError(
        `Invalid v6 block header (unknown=${unknown}, minVersion=${minVersion}, currentVersion=${currentVersion}, type=${blockType}).`
      );
    }

    const offset = this.data.tell();
    const blockInfo: MainBlockInfo = {
      offset,
      size: blockLength,
      blockType,
      minVersion,
      currentVersion,
      extraData: new Uint8Array(0),
    };

    this.currentBlock = blockInfo;
    this.scopeStack.push(blockInfo);
    try {
      const result = callback(blockInfo);
      this.finishBlockScope(blockInfo);
      return result;
    } finally {
      this.scopeStack.pop();
      this.currentBlock = null;
    }
  }

  readSubblock<T>(index: number, callback: (subblock: SubBlockInfo) => T): T {
    this.data.readTag(index, TagType.Length4);
    const subblockLength = this.data.readUint32();
    const offset = this.data.tell();
    const subblock: SubBlockInfo = {
      offset,
      size: subblockLength,
      extraData: new Uint8Array(0),
    };

    this.scopeStack.push(subblock);
    try {
      const result = callback(subblock);
      this.finishBlockScope(subblock);
      return result;
    } finally {
      this.scopeStack.pop();
    }
  }

  private finishBlockScope(info: BlockInfo): void {
    const endOffset = info.offset + info.size;
    const current = this.data.tell();
    if (current > endOffset) {
      throw new BlockOverflowError(
        `Block starting at ${info.offset} (length ${info.size}) read up to ${current} (overflow by ${current - endOffset}).`
      );
    }
    if (current < endOffset) {
      info.extraData = this.data.readBytes(endOffset - current);
    }
  }

  readLwwBool(index: number): LwwValue<boolean> {
    return this.readSubblock(index, () => {
      const timestamp = this.readId(1);
      const value = this.readBool(2);
      return { timestamp, value };
    });
  }

  readLwwByte(index: number): LwwValue<number> {
    return this.readSubblock(index, () => {
      const timestamp = this.readId(1);
      const value = this.readByte(2);
      return { timestamp, value };
    });
  }

  readLwwFloat(index: number): LwwValue<number> {
    return this.readSubblock(index, () => {
      const timestamp = this.readId(1);
      const value = this.readFloat(2);
      return { timestamp, value };
    });
  }

  readLwwId(index: number): LwwValue<CrdtId> {
    return this.readSubblock(index, () => {
      const timestamp = this.readId(1);
      const value = this.readId(2);
      return { timestamp, value };
    });
  }

  readLwwString(index: number): LwwValue<string> {
    return this.readSubblock(index, () => {
      const timestamp = this.readId(1);
      const value = this.readString(2);
      return { timestamp, value };
    });
  }

  readString(index: number): string {
    return this.readSubblock(index, (subblock) => {
      const byteLength = this.data.readVaruint();
      const isAsciiFlag = this.data.readBool();
      if (!isAsciiFlag || byteLength > subblock.size) {
        throw new UnexpectedBlockError(
          `Malformed v6 string block (isAscii=${String(isAsciiFlag)}, len=${byteLength}, blockSize=${subblock.size}).`
        );
      }
      const rawBytes = this.data.readBytes(byteLength);
      return UTF8_DECODER.decode(rawBytes);
    });
  }

  readStringWithFormat(index: number): { text: string; format: number | null } {
    return this.readSubblock(index, (subblock) => {
      const byteLength = this.data.readVaruint();
      const isAsciiFlag = this.data.readBool();
      if (!isAsciiFlag || byteLength > subblock.size) {
        throw new UnexpectedBlockError(
          `Malformed v6 formatted string block (isAscii=${String(isAsciiFlag)}, len=${byteLength}, blockSize=${subblock.size}).`
        );
      }
      const rawBytes = this.data.readBytes(byteLength);
      const text = UTF8_DECODER.decode(rawBytes);
      const format = this.checkTagInScope(2, TagType.Byte4) ? this.readInt(2) : null;
      return { text, format };
    });
  }

  readIntPair(index: number): readonly [number, number] {
    return this.readSubblock(index, () => {
      const first = this.data.readUint32();
      const second = this.data.readUint32();
      return [first, second] as const;
    });
  }
}


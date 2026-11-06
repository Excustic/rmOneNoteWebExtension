import type { ParsedSync15Index, Sync15IndexEntry } from './types';

/**
 * Parses a Sync15 `.docSchema` index text payload (`root.docSchema` or `<docId>.docSchema`).
 *
 * Format specification (`ddvk/rmapi/api/sync15/tree.go`):
 * - Line 1: `"3"` or `"4"`
 * - If `"4"`, Line 2 is a 4-field summary header:
 *   - `0:.:<entriesCount>:<totalSize>` in `root.docSchema`
 *   - `0:<docId>:<entriesCount>:<totalSize>` in `<docId>.docSchema`
 * - Remaining non-empty lines: `<hash>:<entryType>:<id>:<subfiles>:<size>`
 */
export function parseSync15Index(rawText: string): ParsedSync15Index {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('Invalid reMarkable Sync15 index: empty payload.');
  }

  const versionHeader = lines[0];
  if (versionHeader !== '3' && versionHeader !== '4') {
    throw new Error(
      `Unsupported reMarkable Sync15 schema version "${versionHeader}" (expected "3" or "4").`,
    );
  }

  const schemaVersion: 3 | 4 = versionHeader === '4' ? 4 : 3;
  let startLine = 1;

  if (schemaVersion === 4 && lines.length > 1) {
    const secondParts = lines[1].split(':');
    if (secondParts.length === 4) {
      startLine = 2;
    }
  }

  const entries: Sync15IndexEntry[] = [];

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(':');
    if (parts.length !== 5) {
      throw new Error(
        `Malformed reMarkable Sync15 index entry at line ${i + 1}: "${line}".`,
      );
    }

    const [hash, entryType, id, subfilesRaw, sizeRaw] = parts;
    const subfiles = Number.parseInt(subfilesRaw, 10);
    const size = Number.parseInt(sizeRaw, 10);

    entries.push({
      hash,
      entryType,
      id,
      subfiles: Number.isFinite(subfiles) ? subfiles : 0,
      size: Number.isFinite(size) ? size : 0,
    });
  }

  return {
    schemaVersion,
    entries,
  };
}


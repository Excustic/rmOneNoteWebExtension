import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const pkgPath = join(rootDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const version = pkg.version || '0.1.0';
const baseName = 'rm-onenote-sync';
const artifactsDir = join(rootDir, 'artifacts');

mkdirSync(artifactsDir, { recursive: true });

function collectFiles(dirPath, root = dirPath) {
  const entries = [];
  const items = readdirSync(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = join(dirPath, item.name);
    if (item.isDirectory()) {
      entries.push(...collectFiles(fullPath, root));
    } else if (item.isFile()) {
      const stat = statSync(fullPath);
      entries.push({
        absolutePath: fullPath,
        relativePath: relative(root, fullPath).replace(/\\/g, '/'),
        mtime: stat.mtime,
        size: stat.size,
      });
    }
  }

  // Ensure deterministic entry order across builds
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

function buildZipBuffer(sourceDir) {
  if (!existsSync(sourceDir)) {
    throw new Error(`Build directory does not exist: ${sourceDir}. Run 'pnpm run build' first.`);
  }

  const files = collectFiles(sourceDir);
  const localHeaders = [];
  const centralHeaders = [];
  let currentOffset = 0;
  let totalUncompressedSize = 0;

  for (const file of files) {
    const rawData = readFileSync(file.absolutePath);
    totalUncompressedSize += rawData.length;
    const compressed = deflateRawSync(rawData, { level: 9 });
    const crc = crc32(rawData);
    const nameBuf = Buffer.from(file.relativePath, 'utf-8');

    const d = file.mtime;
    const dosTime =
      ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
    const dosDate =
      (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // General purpose bit flag: UTF-8 encoding
    localHeader.writeUInt16LE(8, 8); // Compression method: Deflated
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBuf.copy(localHeader, 30);

    const localOffset = currentOffset;
    currentOffset += localHeader.length + compressed.length;
    localHeaders.push(localHeader, compressed);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8
    centralHeader.writeUInt16LE(8, 10); // Deflated
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // Comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // External file attributes (standard POSIX 644)
    centralHeader.writeUInt32LE(localOffset, 42); // Relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
  }

  const centralDirStart = currentOffset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    centralDirSize += ch.length;
  }

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8); // Central directory records on this disk
  eocd.writeUInt16LE(files.length, 10); // Total central directory records
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20); // ZIP comment length

  const buffer = Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  return { buffer, fileCount: files.length, uncompressedSize: totalUncompressedSize };
}

const TARGETS = [
  {
    targetId: 'chrome',
    browserLabel: 'Google Chrome / Chromium',
    sourceDir: join(rootDir, 'dist/chromium'),
    filename: `${baseName}-chrome-v${version}.zip`,
  },
  {
    targetId: 'firefox',
    browserLabel: 'Mozilla Firefox (AMO)',
    sourceDir: join(rootDir, 'dist/firefox'),
    filename: `${baseName}-firefox-v${version}.zip`,
    createXpi: true,
  },
  {
    targetId: 'edge',
    browserLabel: 'Microsoft Edge (Edge Add-ons)',
    sourceDir: join(rootDir, 'dist/chromium'),
    filename: `${baseName}-edge-v${version}.zip`,
  },
  {
    targetId: 'opera',
    browserLabel: 'Opera (Opera Add-ons)',
    sourceDir: join(rootDir, 'dist/chromium'),
    filename: `${baseName}-opera-v${version}.zip`,
  },
];

console.log(`Packaging extension packages (v${version})...\n`);

const checksums = [];
const summaryRows = [];

// Cache built zip buffers so shared source directories (Chrome/Edge/Opera) are compressed once
const bufferCache = new Map();

for (const target of TARGETS) {
  let cached = bufferCache.get(target.sourceDir);
  if (!cached) {
    cached = buildZipBuffer(target.sourceDir);
    bufferCache.set(target.sourceDir, cached);
  }

  const destZipPath = join(artifactsDir, target.filename);
  writeFileSync(destZipPath, cached.buffer);

  const hash = createHash('sha256').update(cached.buffer).digest('hex');
  checksums.push(`${hash}  ${target.filename}`);

  summaryRows.push({
    target: target.browserLabel,
    filename: target.filename,
    files: cached.fileCount,
    uncompressed: `${(cached.uncompressedSize / 1024).toFixed(1)} KB`,
    compressed: `${(cached.buffer.length / 1024).toFixed(1)} KB`,
    sha256: hash.slice(0, 16) + '...',
  });

  if (target.createXpi) {
    const xpiFilename = `${baseName}-firefox-v${version}.xpi`;
    const destXpiPath = join(artifactsDir, xpiFilename);
    copyFileSync(destZipPath, destXpiPath);
    checksums.push(`${hash}  ${xpiFilename}`);
    summaryRows.push({
      target: 'Mozilla Firefox (.xpi bundle)',
      filename: xpiFilename,
      files: cached.fileCount,
      uncompressed: `${(cached.uncompressedSize / 1024).toFixed(1)} KB`,
      compressed: `${(cached.buffer.length / 1024).toFixed(1)} KB`,
      sha256: hash.slice(0, 16) + '...',
    });
  }
}

// Write SHA256SUMS.txt
const sumsPath = join(artifactsDir, 'SHA256SUMS.txt');
writeFileSync(sumsPath, checksums.join('\n') + '\n');

console.table(summaryRows);
console.log(`\nGenerated ${summaryRows.length} distribution bundles in artifacts/`);
console.log(`Wrote checksum file: artifacts/SHA256SUMS.txt`);

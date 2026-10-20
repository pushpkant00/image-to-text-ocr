// Zips dist/ into release/ for the Chrome Web Store "Upload package" step.
//
//   npm run package
//
// Writes the archive itself (node:zlib) so entry names always use forward
// slashes — PowerShell's Compress-Archive emits backslashes, which the Web
// Store rejects. Run `npm run build` first.
import { existsSync, readFileSync, mkdirSync, rmSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const manifestPath = join(dist, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error('dist/manifest.json not found — run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
const slug = manifest.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// ---------- collect files ----------
interface Entry {
  name: string;
  data: Buffer;
}

function walk(dir: string, base: string, out: Entry[]): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) walk(full, base, out);
    else out.push({ name: relative(base, full).split('\\').join('/'), data: readFileSync(full) });
  }
}

const files: Entry[] = [];
walk(dist, dist, files);
files.sort((a, b) => a.name.localeCompare(b.name));

// ---------- minimal zip writer ----------
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const locals: Buffer[] = [];
const centrals: Buffer[] = [];
let offset = 0;

for (const file of files) {
  const name = Buffer.from(file.name, 'utf8');
  const raw = file.data;
  const deflated = deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralDir = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralDir.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const releaseDir = join(root, 'release');
mkdirSync(releaseDir, { recursive: true });
const out = join(releaseDir, `${slug}-${manifest.version}.zip`);
rmSync(out, { force: true });
writeFileSync(out, Buffer.concat([...locals, centralDir, eocd]));

const size = statSync(out).size;
console.log(`Packaged ${files.length} files (${(size / 1024).toFixed(0)} KB) -> ${out}`);
console.log(
  `Upload at https://chrome.google.com/webstore/devconsole — version ${manifest.version}.`,
);

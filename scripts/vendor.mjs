// Copies the browser assets we depend on out of node_modules into public/vendor
// so the HTTP server only ever serves files from public/ (no runtime coupling to
// node_modules layout). Re-run with `npm run vendor` after upgrading xterm.
import { mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(root, 'public', 'vendor');
const nm = path.join(root, 'node_modules');

const files = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

await mkdir(dest, { recursive: true });
let copied = 0;
for (const [src, out] of files) {
  const from = path.join(nm, src);
  try {
    await access(from);
  } catch {
    console.warn(`vendor: skipped missing ${src} (run npm install first)`);
    continue;
  }
  await copyFile(from, path.join(dest, out));
  copied++;
}
console.log(`vendor: copied ${copied}/${files.length} assets to public/vendor`);

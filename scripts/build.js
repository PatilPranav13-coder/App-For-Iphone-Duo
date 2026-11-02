import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const codeDirectories = ['src', 'server', 'scripts', 'tests'];

function checkJavaScript(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) checkJavaScript(file);
    else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}

for (const directory of codeDirectories) checkJavaScript(path.join(root, directory));
mkdirSync(output, { recursive: true });
for (const name of ['index.html', 'manifest.json', 'service-worker.js', 'assets', 'src']) {
  cpSync(path.join(root, name), path.join(output, name), { recursive: true, force: true });
}
console.log('Tessera production files are ready in dist/.');

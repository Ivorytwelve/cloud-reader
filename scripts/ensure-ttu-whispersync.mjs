import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = join(root, 'apps/web/src/lib/whispersync-upstream/components/AudioBookMenu.svelte');

try {
  await access(marker);
} catch {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/vendor-ttu-whispersync.mjs')], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vendor script exited with ${code}`))));
    child.on('error', reject);
  });
}

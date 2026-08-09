import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repo = 'Renji-XD/ttu-whispersync';
const ref = process.env.TTU_WHISPERSYNC_REF || '1.0.12';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'apps/web/src/lib/whispersync-upstream');

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'ttu-cloud-reader-vendor' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'ttu-cloud-reader-vendor' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

function shouldVendor(path) {
  if (!path.startsWith('src/')) return false;
  if (path.startsWith('src/content/')) return false;
  if (path.startsWith('src/sandbox/')) return false;
  if (path === 'src/manifest.config.ts') return false;
  return true;
}

function patchNativeRuntime(path, source) {
  if (path === 'src/lib/mediaInfo.ts') {
    source = source.replace(
      "import MediaInfoFactory from 'mediainfo.js';",
      "import MediaInfoFactory from 'mediainfo.js';\nimport mediaInfoWasmUrl from '../assets/js/MediaInfoModule_0.2.1.wasm?url';",
    );
    source = source.replace(
      "locateFile: () => mediaInfoUrl || window.GM_getResourceURL('mediaInfo'),",
      "locateFile: () => mediaInfoUrl || mediaInfoWasmUrl,",
    );
    source = source.replace(
      /return coverMimeType[\s\S]*?: '';\n}/m,
      `if (!coverMimeType) {\n\t\treturn '';\n\t}\n\n\tconst binary = atob(coverData);\n\tconst bytes = new Uint8Array(binary.length);\n\tfor (let index = 0; index < binary.length; index += 1) {\n\t\tbytes[index] = binary.charCodeAt(index);\n\t}\n\n\treturn URL.createObjectURL(new Blob([bytes], { type: coverMimeType }));\n}`,
    );
  }

  if (path === 'src/lib/ffmpeg.ts') {
    source = source.replace(
      "const isChromeExtension = !!window.chrome && !!chrome.runtime && chrome.runtime.id;",
      "const isChromeExtension = false; // native Ttsu integration",
    );
    source = source.replace(
      "const isTampermonkeyScript = !!window.GM_info && window.GM_info.scriptHandler === 'Tampermonkey';",
      "const isTampermonkeyScript = false; // native Ttsu integration",
    );
    source = source.replace(
      "import ffmpegWorker from '../assets/js/ffmpeg.worker?url';",
      "import ffmpegWorker from '../assets/js/ffmpeg.worker?url';\nimport ffmpegCoreUrl from '../assets/js/ffmpeg-core.js?url';\nimport ffmpegCoreWasmUrl from '../assets/js/ffmpeg-core.wasm?url';",
    );
    source = source.replace(
      /const externalResources = new Map\(\[[\s\S]*?\]\);/m,
      `const externalResources = new Map([\n\t['ffmpeg-core.js', { url: ffmpegCoreUrl, version: '0.12.6' }],\n\t['ffmpeg-core.wasm', { url: ffmpegCoreWasmUrl, version: '0.12.6' }],\n]);`,
    );
    source = source.replace(
      /function getUrl\(fileName: string, type = 'text\/javascript'\) \{[\s\S]*?\n\}/m,
      `function getUrl(fileName: string, type = 'text/javascript') {\n\tif (fileName === ffmpegWorker) return toBlobURL(fileName, ffmpegWorker, type);\n\tconst resource = externalResources.get(fileName);\n\tif (resource) return toBlobURL(fileName, resource.url, type);\n\tthrow new Error(\`No data found for resource \${fileName}\`);\n}`,
    );
    source = source.replace(
      /const file = \(await ffmpeg\.readFile\(finalOutput\)\) as unknown as Buffer;\s*buffer = file\.buffer;/m,
      `const file = await ffmpeg.readFile(finalOutput);\n\t\tif (typeof file === 'string') {\n\t\t\tthrow new Error('FFmpeg returned text instead of binary audio data');\n\t\t}\n\n\t\tbuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);`,
    );
  }

  if (path === 'src/lib/anki.ts') {
    source = source.replace(
      "let permissionGranted = false;\nlet key = '';",
      `let permissionGranted = false;\nlet key = '';\n\nfunction arrayBufferToBase64(buffer: ArrayBufferLike): string {\n\tconst bytes = new Uint8Array(buffer);\n\tconst chunkSize = 0x8000;\n\tlet binary = '';\n\tfor (let offset = 0; offset < bytes.length; offset += chunkSize) {\n\t\tbinary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));\n\t}\n\treturn btoa(binary);\n}`,
    );
    source = source.replaceAll("Buffer.from(blobBuffer).toString('base64')", 'arrayBufferToBase64(blobBuffer)');
    source = source.replaceAll("Buffer.from(audioBuffer).toString('base64')", 'arrayBufferToBase64(audioBuffer)');
  }

  if (path === 'src/components/Player.svelte') {
    const syncLine = "document.dispatchEvent(new CustomEvent('ttu-action', { detail: { type: 'sync', syncType: 'audioBook' } }));";
    if (source.includes(syncLine)) {
      source = source.replace(
        syncLine,
        `${syncLine}\n\t\t\tdocument.dispatchEvent(\n\t\t\t\tnew CustomEvent('ttu-cloud:audiobook-progress', {\n\t\t\t\t\tdetail: { seconds: playbackPosition, duration: $duration$, playbackRate: $playbackRate$, paused: $paused$ },\n\t\t\t\t}),\n\t\t\t);`,
      );
    }
  }

  if (path === 'src/lib/files.ts') {
    // Native Ttsu never needs the Chrome-extension sandbox. Avoid chrome.runtime
    // references and call MediaInfo directly in the page context.
    source = source.replace(
      /metadata = await \(sandboxElement[\s\S]*?: getAudioMetadata\(file, enableCover\)\);/m,
      'metadata = await getAudioMetadata(file, enableCover);',
    );
  }

  return source;
}

async function main() {
  console.log(`Vendoring ${repo}@${ref}...`);
  const tree = await getJson(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (tree.truncated) throw new Error('GitHub returned a truncated repository tree');
  const files = tree.tree.filter((entry) => entry.type === 'blob' && shouldVendor(entry.path));

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const [index, entry] of files.entries()) {
    const relative = entry.path.replace(/^src\//, '');
    const destination = join(target, relative);
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${ref}/${entry.path}`;
    let source = await getText(rawUrl);
    source = patchNativeRuntime(entry.path, source);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
    process.stdout.write(`\r${index + 1}/${files.length} ${relative.padEnd(55)}`);
  }
  process.stdout.write('\n');

  const license = await getText(`https://raw.githubusercontent.com/${repo}/${ref}/LICENSE`);
  await writeFile(join(target, 'LICENSE.ttu-whispersync'), license);
  await writeFile(
    join(target, 'UPSTREAM.md'),
    `# ttu-whispersync upstream\n\nVendored from https://github.com/${repo} at ref \`${ref}\`.\n\nThe source remains under its upstream MIT license. Local changes only adapt resource loading and mounting for native Ttsu use.\n`,
  );
  console.log('ttu-whispersync vendored and patched for native Ttsu use.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

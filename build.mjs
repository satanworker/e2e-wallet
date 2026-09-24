import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/extension', { recursive: true });
await build({
  entryPoints: ['src/coordinator.mjs'],
  outfile: 'dist/coordinator.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
});
await cp('extension', 'dist/extension', { recursive: true });

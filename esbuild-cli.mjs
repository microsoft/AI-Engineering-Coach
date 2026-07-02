import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Standalone CLI bundle (dist/cli.js). Kept separate from esbuild.mjs so the
// extension build pipeline stays untouched.
await esbuild.build({
  entryPoints: [path.join(__dirname, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(__dirname, 'dist', 'cli.js'),
  format: 'cjs',
  sourcemap: false,
  minify: false,
});

console.log('CLI build complete: dist/cli.js');

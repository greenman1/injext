const { cpSync, existsSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

rmSync(dist, { recursive: true, force: true });

const tsc = require.resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '--project', path.join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const mutations = path.join(root, 'src', 'mutations');
if (!existsSync(mutations)) {
  throw new Error(`Mutation assets directory not found: ${mutations}`);
}

cpSync(mutations, path.join(dist, 'mutations'), { recursive: true });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanProject } = require('../dist/engine/scan');
const { buildPatchPlan, loadMutationSpec } = require('../dist/engine/planner');
const { applyPatchPlan } = require('../dist/engine/patcher');
const { recordMutation } = require('../dist/engine/ledger');
const { rollbackMutation } = require('../dist/engine/rollback');

function createFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmod-test-'));
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'package.json'),
    JSON.stringify({ dependencies: { express: '^4.21.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(rootDir, 'src', 'server.ts'),
    [
      "import express from 'express';",
      'const app = express();',
      'app.use(express.json());',
      'app.listen(3000);',
      '',
    ].join('\n')
  );
  return rootDir;
}

test('applies and rolls back a route with portable private state', async t => {
  const rootDir = createFixture();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const entryFile = path.join(rootDir, 'src', 'server.ts');
  const originalEntry = fs.readFileSync(entryFile, 'utf8');
  const profile = await scanProject(rootDir);
  const spec = loadMutationSpec('route');
  const plan = buildPatchPlan(spec, profile, { name: 'users', routeName: 'users' });
  const rollbackId = 'add-route-users-test';
  const result = await applyPatchPlan(plan, profile, rollbackId);
  const entry = recordMutation(
    rootDir,
    'add-route:users',
    plan.version,
    result.filesCreated,
    result.filesModified,
    result.backupDir,
    rollbackId
  );

  assert.equal(fs.existsSync(path.join(rootDir, 'src', 'routes', 'users.ts')), true);
  assert.match(fs.readFileSync(entryFile, 'utf8'), /STACKMOD_ROUTES_START/);
  assert.equal(entry.files_created.every(file => !path.isAbsolute(file)), true);
  assert.equal(entry.files_modified.every(file => !path.isAbsolute(file)), true);
  assert.equal(path.isAbsolute(entry.backup_dir), false);
  assert.equal(
    fs.readFileSync(path.join(rootDir, '.injext', '.gitignore'), 'utf8'),
    '*\n!.gitignore\n'
  );

  await rollbackMutation(rootDir, rollbackId);

  assert.equal(fs.existsSync(path.join(rootDir, 'src', 'routes', 'users.ts')), false);
  assert.equal(fs.readFileSync(entryFile, 'utf8'), originalEntry);
});

test('rollback restores dependency and environment-file changes', async t => {
  const rootDir = createFixture();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const packagePath = path.join(rootDir, 'package.json');
  const originalPackage = fs.readFileSync(packagePath, 'utf8');
  const profile = await scanProject(rootDir);
  const spec = loadMutationSpec('auth');
  const plan = buildPatchPlan(spec, profile);
  const rollbackId = 'add-auth-test';
  const result = await applyPatchPlan(plan, profile, rollbackId);
  recordMutation(
    rootDir,
    'add-auth',
    plan.version,
    result.filesCreated,
    result.filesModified,
    result.backupDir,
    rollbackId
  );

  const mutatedPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  assert.equal(mutatedPackage.dependencies.jsonwebtoken, '*');
  assert.match(fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8'), /JWT_SECRET=/);

  await rollbackMutation(rootDir, rollbackId);

  assert.equal(fs.readFileSync(packagePath, 'utf8'), originalPackage);
  assert.equal(fs.existsSync(path.join(rootDir, '.env.example')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'src', 'auth.routes.ts')), false);
});

test('rejects mutation output paths outside the target project', async t => {
  const rootDir = createFixture();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const profile = await scanProject(rootDir);
  const spec = loadMutationSpec('route');

  assert.throws(
    () => buildPatchPlan(spec, profile, {
      name: '../../../../escape',
      routeName: '../../../../escape',
    }),
    /must resolve to a file inside/
  );
});

test('refuses tampered rollback paths before deleting files', async t => {
  const rootDir = createFixture();
  const outsideFile = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-outside.txt`);
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  });

  fs.writeFileSync(outsideFile, 'keep');
  fs.mkdirSync(path.join(rootDir, '.injext'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, '.injext', 'ledger.json'),
    JSON.stringify({
      entries: [{
        id: 'tampered',
        mutation: 'add-route:users',
        version: '0.1.0',
        applied_at: new Date(0).toISOString(),
        files_created: [`../${path.basename(outsideFile)}`],
        files_modified: [],
        backup_dir: '.injext/backups/tampered',
      }],
    })
  );

  await assert.rejects(() => rollbackMutation(rootDir, 'tampered'), /outside the project/);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep');
});

test('restores partial changes when applying a plan fails', async t => {
  const rootDir = createFixture();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const profile = await scanProject(rootDir);
  const createdPath = path.join(rootDir, 'src', 'temporary.ts');
  const plan = {
    mutationId: 'failure-test',
    version: '0.0.0',
    operations: [
      { type: 'create_file', path: createdPath, content: 'temporary\n' },
      {
        type: 'append_file',
        path: path.join(rootDir, 'missing.ts'),
        content: 'never written\n',
      },
    ],
    filesToCreate: ['src/temporary.ts'],
    filesToModify: ['missing.ts'],
    depsToAdd: [],
    envToAdd: [],
  };

  await assert.rejects(
    () => applyPatchPlan(plan, profile, 'failure-test'),
    /Cannot append to non-existent file/
  );
  assert.equal(fs.existsSync(createdPath), false);
  assert.equal(
    fs.existsSync(path.join(rootDir, '.injext', 'backups', 'failure-test')),
    false
  );
});

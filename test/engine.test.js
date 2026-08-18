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

function createdFile(plan, fileName) {
  const operation = plan.operations.find(
    op => op.type === 'create_file' && path.basename(op.path) === fileName
  );
  assert.ok(operation, `Expected ${fileName} in patch plan`);
  return operation.content;
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
  assert.equal(mutatedPackage.dependencies.jsonwebtoken, '^9.0.3');
  assert.match(fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8'), /JWT_SECRET=/);

  await rollbackMutation(rootDir, rollbackId);

  assert.equal(fs.readFileSync(packagePath, 'utf8'), originalPackage);
  assert.equal(fs.existsSync(path.join(rootDir, '.env.example')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'src', 'auth.routes.ts')), false);
});

test('generated auth and admin code uses signed roles with a safe bootstrap secret', async t => {
  const rootDir = createFixture();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const profile = await scanProject(rootDir);
  const authPlan = buildPatchPlan(loadMutationSpec('auth'), profile);
  const authMiddleware = createdFile(authPlan, 'auth.middleware.ts');
  const authRoutes = createdFile(authPlan, 'auth.routes.ts');
  const jwtDependency = authPlan.operations.find(
    op => op.type === 'add_dependency' && op.name === 'jsonwebtoken'
  );

  assert.equal(jwtDependency.version, '^9.0.3');
  assert.match(authMiddleware, /algorithms: \['HS256'\]/);
  assert.match(authMiddleware, /role:\s+'user' \| 'admin'/);
  assert.match(authRoutes, /algorithm: 'HS256'/);
  assert.match(authRoutes, /role: user\.role/);

  const adminPlan = buildPatchPlan(loadMutationSpec('admin'), profile);
  const adminMiddleware = createdFile(adminPlan, 'admin.middleware.ts');
  const adminRoutes = createdFile(adminPlan, 'admin.routes.ts');

  assert.match(adminMiddleware, /timingSafeEqual/);
  assert.match(adminMiddleware, /user\?\.role === 'admin'/);
  assert.match(adminRoutes, /Symbol\.for\('injext\.auth\.users'\)/);
  assert.match(adminRoutes, /role must be "admin" or "user"/);

  const replitProfile = { ...profile, template: 'replit-fullstack' };
  const replitAuthPlan = buildPatchPlan(loadMutationSpec('auth'), replitProfile);
  const replitAdminPlan = buildPatchPlan(loadMutationSpec('admin'), replitProfile);
  const authSchemaAppend = replitAuthPlan.operations.find(
    op => op.type === 'append_file' && path.basename(op.path) === 'schema.ts'
  );
  assert.ok(authSchemaAppend);
  assert.match(createdFile(replitAuthPlan, 'auth.routes.ts'), /role: user\.role/);
  assert.match(authSchemaAppend.content, /role: text\('role'\)/);
  assert.match(
    createdFile(replitAdminPlan, 'admin.routes.ts'),
    /db\.update\(authUsersTable\)\.set\(\{ role \}\)/
  );
});

test('billing webhooks are bounded and mounted before JSON parsing', async t => {
  const rootDir = createFixture();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const profile = await scanProject(rootDir);
  const plan = buildPatchPlan(loadMutationSpec('billing'), profile);
  const replitPlan = buildPatchPlan(
    loadMutationSpec('billing'),
    { ...profile, template: 'replit-fullstack' }
  );
  const replitEntryInjection = replitPlan.operations.find(op => op.type === 'modify_file');
  const result = await applyPatchPlan(plan, profile, 'billing-hardening-test');
  const entry = fs.readFileSync(path.join(rootDir, 'src', 'server.ts'), 'utf8');
  const routes = fs.readFileSync(path.join(rootDir, 'src', 'billing.routes.ts'), 'utf8');
  const webhook = fs.readFileSync(path.join(rootDir, 'src', 'billing.webhook.ts'), 'utf8');
  const mutatedPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

  const earlyRouteIndex = entry.indexOf('STACKMOD_EARLY_ROUTES_START');
  const globalJsonIndex = entry.indexOf('express.json()');
  const webhookRouteIndex = routes.indexOf("router.use('/webhook'");
  const localJsonIndex = routes.indexOf('router.use(json())');
  assert.notEqual(earlyRouteIndex, -1);
  assert.notEqual(globalJsonIndex, -1);
  assert.ok(earlyRouteIndex < globalJsonIndex);
  assert.notEqual(webhookRouteIndex, -1);
  assert.notEqual(localJsonIndex, -1);
  assert.ok(webhookRouteIndex < localJsonIndex);
  assert.match(webhook, /STRIPE_WEBHOOK_MAX_BYTES/);
  assert.match(webhook, /Buffer\.concat/);
  assert.match(webhook, /status\(413\)/);
  assert.doesNotMatch(webhook, /Webhook signature invalid: \$\{err\.message\}/);
  assert.ok(replitEntryInjection);
  assert.equal(replitEntryInjection.path, profile.entryFile);
  assert.equal(replitEntryInjection.mount, '/api/billing');
  assert.equal(replitEntryInjection.beforeBodyParser, true);
  assert.equal(mutatedPackage.dependencies.stripe, '^22.5.0');
  assert.equal(result.filesCreated.includes(path.join(rootDir, '.env.example')), true);
});

test('feature-flag bucketing uses SHA-256', async t => {
  const rootDir = createFixture();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const profile = await scanProject(rootDir);
  const plan = buildPatchPlan(loadMutationSpec('feature-flags'), profile);
  const service = createdFile(plan, 'flags.service.ts');

  assert.match(service, /createHash\('sha256'\)/);
  assert.doesNotMatch(service, /createHash\('md5'\)/);
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

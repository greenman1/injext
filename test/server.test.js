const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tar = require('tar');

process.env.STACKMOD_API_TOKEN = 'server-test-token';
process.env.STACKMOD_LOG_LEVEL = 'silent';
const { app } = require('../dist/server/server');

test.after(async () => {
  await app.close();
});

test('hosted engine exposes a health response', async () => {
  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'Injext Engine running' });
});

test('hosted mutation endpoint requires a bearer token', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/mutate?mutation=auth',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('not-an-archive'),
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { success: false, error: 'Unauthorized' });
});

test('hosted mutation endpoint rejects unsafe mutation names', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/mutate?mutation=..%2Fprivate',
    headers: {
      authorization: 'Bearer server-test-token',
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.from('not-an-archive'),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { success: false, error: 'Invalid mutation name' });
});

test('hosted mutation endpoint returns only changed project files', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmod-server-test-'));
  const inputDir = path.join(rootDir, 'input');
  const outputDir = path.join(rootDir, 'output');
  const inputArchive = path.join(rootDir, 'input.tar.gz');
  const outputArchive = path.join(rootDir, 'output.tar.gz');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(inputDir, 'src'), { recursive: true });
  fs.mkdirSync(outputDir);
  fs.writeFileSync(
    path.join(inputDir, 'package.json'),
    JSON.stringify({ dependencies: { express: '^4.21.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(inputDir, 'src', 'server.ts'),
    [
      "import express from 'express';",
      'const app = express();',
      'app.use(express.json());',
      'app.listen(3000);',
      '',
    ].join('\n')
  );
  await tar.c(
    { cwd: inputDir, file: inputArchive, gzip: true },
    ['package.json', 'src/server.ts']
  );

  const response = await app.inject({
    method: 'POST',
    url: '/mutate?mutation=auth',
    headers: {
      authorization: 'Bearer server-test-token',
      'content-type': 'application/octet-stream',
    },
    payload: fs.readFileSync(inputArchive),
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'], /^application\/gzip/);
  fs.writeFileSync(outputArchive, response.rawPayload);
  await tar.x({ cwd: outputDir, file: outputArchive });

  assert.equal(fs.existsSync(path.join(outputDir, 'src', 'auth.routes.ts')), true);
  assert.equal(fs.existsSync(path.join(outputDir, 'src', 'auth.middleware.ts')), true);
  assert.equal(fs.existsSync(path.join(outputDir, '.injext')), false);
});

import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

interface MutateQuery {
  mutation?: string;
}

interface LedgerEntry {
  files_created: string[];
  files_modified: string[];
}

interface Ledger {
  entries: LedgerEntry[];
}

const MIB = 1024 * 1024;
const MUTATION_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_UPLOAD_BYTES = readPositiveInteger('STACKMOD_MAX_UPLOAD_BYTES', 25 * MIB);
const MAX_EXTRACTED_BYTES = readPositiveInteger('STACKMOD_MAX_EXTRACTED_BYTES', 250 * MIB);
const MAX_ARCHIVE_ENTRIES = readPositiveInteger('STACKMOD_MAX_ARCHIVE_ENTRIES', 20_000);
const MUTATION_TIMEOUT_MS = readPositiveInteger('STACKMOD_MUTATION_TIMEOUT_MS', 60_000);
const configuredApiToken = process.env.STACKMOD_API_TOKEN;
const ALLOWED_ARCHIVE_ENTRY_TYPES = new Set(['File', 'OldFile', 'ContiguousFile', 'Directory']);

if (!configuredApiToken) {
  throw new Error('STACKMOD_API_TOKEN must be set before starting the hosted engine.');
}
const API_TOKEN: string = configuredApiToken;

export const app = Fastify({
  bodyLimit: MAX_UPLOAD_BYTES,
  logger: { level: process.env.STACKMOD_LOG_LEVEL ?? 'info' },
});

app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body)
);

app.get('/', async () => {
  return { status: 'Injext Engine running' };
});

app.post<{ Querystring: MutateQuery }>(
  '/mutate',
  { preHandler: authorizeRequest },
  async (req, reply) => {
    const { mutation } = req.query;

    if (!mutation) {
      return reply.status(400).send({ success: false, error: 'Missing ?mutation= query param' });
    }

    if (!MUTATION_NAME_RE.test(mutation)) {
      return reply.status(400).send({ success: false, error: 'Invalid mutation name' });
    }

    if (!Buffer.isBuffer(req.body)) {
      return reply.status(400).send({ success: false, error: 'Expected a tar.gz request body' });
    }

    const requestId = crypto.randomUUID();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmod-'));
    const workdir = path.join(tempRoot, 'project');
    const tarIn = path.join(tempRoot, 'input.tar.gz');
    const tarOut = path.join(tempRoot, 'changes.tar.gz');

    try {
      fs.mkdirSync(workdir);
      fs.writeFileSync(tarIn, req.body);
      await extractProjectArchive(tarIn, workdir);

      const cliEntry = path.resolve(__dirname, '..', 'cli.js');
      execFileSync(process.execPath, [cliEntry, 'add', mutation, '--yes'], {
        cwd: workdir,
        stdio: 'pipe',
        timeout: MUTATION_TIMEOUT_MS,
        maxBuffer: 10 * MIB,
      });

      const ledgerPath = path.join(workdir, '.injext', 'ledger.json');
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Ledger;
      const latest = ledger.entries.at(-1);
      if (!latest) {
        throw new Error('Mutation completed without a ledger entry.');
      }

      const changedFiles = [...new Set([
        ...latest.files_created,
        ...latest.files_modified,
      ].map(file => safeProjectRelativePath(workdir, file)))];

      await tar.c(
        {
          cwd: workdir,
          file: tarOut,
          gzip: true,
          portable: true,
          noMtime: true,
        },
        changedFiles
      );

      reply.header('Content-Type', 'application/gzip');
      reply.header('Content-Disposition', 'attachment; filename=changes.tar.gz');
      reply.header('X-Request-Id', requestId);
      return reply.send(fs.readFileSync(tarOut));
    } catch (error: unknown) {
      req.log.error({ requestId, error: errorMessage(error) }, 'Mutation request failed');
      return reply.status(500).send({
        success: false,
        error: 'Mutation failed',
        requestId,
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
);

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function authorizeRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const prefix = 'Bearer ';

  if (!header?.startsWith(prefix)) {
    await reply.status(401).send({ success: false, error: 'Unauthorized' });
    return;
  }

  const provided = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(API_TOKEN, 'utf8');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    await reply.status(401).send({ success: false, error: 'Unauthorized' });
  }
}

async function extractProjectArchive(archivePath: string, workdir: string): Promise<void> {
  let entryCount = 0;
  let extractedBytes = 0;

  await tar.x({
    cwd: workdir,
    file: archivePath,
    strict: true,
    preservePaths: false,
    unlink: true,
    maxDecompressionRatio: 100,
    filter: (entryPath, rawEntry) => {
      const entry = rawEntry as tar.ReadEntry;
      assertSafeArchivePath(entryPath);

      if (!ALLOWED_ARCHIVE_ENTRY_TYPES.has(entry.type)) {
        throw new Error('Archive contains an unsupported entry type.');
      }

      entryCount += 1;
      extractedBytes += Math.max(0, entry.size ?? 0);
      if (entryCount > MAX_ARCHIVE_ENTRIES || extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error('Archive exceeds extraction limits.');
      }

      return true;
    },
  });
}

function assertSafeArchivePath(entryPath: string): void {
  const normalized = entryPath.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.');

  if (
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    parts.includes('..') ||
    parts[0] === '.git' ||
    parts[0] === '.injext'
  ) {
    throw new Error('Archive contains an unsafe path.');
  }
}

function safeProjectRelativePath(rootDir: string, storedPath: string): string {
  const resolved = path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(rootDir, storedPath);
  const relative = path.relative(rootDir, resolved);

  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Ledger contains a path outside the project.');
  }

  return relative.split(path.sep).join('/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startServer(): Promise<void> {
  const port = readPositiveInteger('PORT', 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

if (require.main === module) {
  startServer().catch(error => {
    app.log.error(error);
    process.exit(1);
  });
}

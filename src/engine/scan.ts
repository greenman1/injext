import * as path from 'path';
import { CodebaseProfile, Template } from './profile';
import { fileExists, readJSON, findFirstExisting, readFile } from '../utils/fs';

// Candidate entry files in priority order
const ENTRY_CANDIDATES = [
    'server/index.ts',  // Replit fullstack template
    'server/index.js',
    'src/server.ts',
    'src/index.ts',
    'server.ts',
    'index.ts',
    'src/server.js',
    'src/index.js',
    'server.js',
    'index.js',
];

/**
 * Scan the given directory and produce a CodebaseProfile.
 * Throws if the project is incompatible with StackMod MVP.
 */
export async function scanProject(rootDir: string): Promise<CodebaseProfile> {
    // ── 1. Read package.json ────────────────────────────────────────────────────
    const pkgPath = path.resolve(rootDir, 'package.json');
    if (!fileExists(pkgPath)) {
        throw new Error(`No package.json found in ${rootDir}. Is this a Node.js project?`);
    }

    const pkg = readJSON<Record<string, unknown>>(pkgPath);
    const deps = {
        ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
        ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
        ...((pkg.peerDependencies as Record<string, string> | undefined) ?? {}),
    };

    // ── 2. Detect framework ─────────────────────────────────────────────────────
    const framework = detectFramework(deps);

    // ── 3. Detect language ──────────────────────────────────────────────────────
    const language = detectLanguage(rootDir, deps);

    // ── 4. Detect entry file ────────────────────────────────────────────────────
    const entryFile = findFirstExisting(rootDir, ENTRY_CANDIDATES);
    if (!entryFile) {
        throw new Error(
            `Could not detect a server entry file.\n` +
            `Looked for: ${ENTRY_CANDIDATES.join(', ')}\n` +
            `Make sure you are running stackmod from your project root.`
        );
    }

    // ── 5. Detect template and serverDir ────────────────────────────────────────
    const { template, serverDir, sharedDir, dbFile } = detectTemplate(rootDir, entryFile);

    return {
        framework,
        language,
        template,
        serverDir,
        sharedDir,
        dbFile,
        entryFile,
        rootDir,
        packageJson: pkg,
    };
}

const DB_FILE_CANDIDATES = ['db.ts', 'db.js', 'database.ts', 'database.js', 'storage.ts', 'storage.js'];

function detectDbFile(rootDir: string, serverDir: string): string {
    for (const candidate of DB_FILE_CANDIDATES) {
        if (fileExists(path.resolve(rootDir, serverDir, candidate))) {
            return './' + candidate.replace(/\.(ts|js)$/, '');
        }
    }
    return './db'; // fallback — standard Replit name
}

function detectTemplate(
    rootDir: string,
    entryFile: string
): { template: Template; serverDir: string; sharedDir: string; dbFile: string } {
    // Compute serverDir: directory of entry file relative to rootDir
    const relEntry = path.relative(rootDir, entryFile);
    const dir = path.dirname(relEntry);
    const serverDir = dir === '.' ? '.' : dir;

    // Replit fullstack template: has server/routes.ts with registerRoutes
    const routesFile = path.resolve(rootDir, 'server', 'routes.ts');
    if (fileExists(routesFile)) {
        const content = readFile(routesFile);
        if (content.includes('registerRoutes')) {
            const dbFile = detectDbFile(rootDir, serverDir);
            return { template: 'replit-fullstack', serverDir, sharedDir: 'shared', dbFile };
        }
    }

    const dbFile = detectDbFile(rootDir, serverDir);
    return { template: 'express', serverDir, sharedDir: serverDir, dbFile };
}

function detectFramework(deps: Record<string, string>): CodebaseProfile['framework'] {
    if ('express' in deps) return 'express';
    return 'unknown';
}

function detectLanguage(
    rootDir: string,
    deps: Record<string, string>
): CodebaseProfile['language'] {
    const hasTsConfig = fileExists(path.resolve(rootDir, 'tsconfig.json'));
    const hasTypescript = 'typescript' in deps || '@types/node' in deps;
    if (hasTsConfig || hasTypescript) return 'typescript';

    return 'javascript';
}

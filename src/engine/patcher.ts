import * as path from 'path';
import * as fsBase from 'fs';
import {
    PatchPlan,
    PatchOperation,
    CreateFileOp,
    ModifyFileOp,
    AddDependencyOp,
    AppendFileOp,
    InsertBeforePatternOp,
    CodebaseProfile,
} from './profile';
import { readFile, writeFile, fileExists, readJSON, writeJSON } from '../utils/fs';

// ─── Constants ────────────────────────────────────────────────────────────────

const MARKER_START = '// STACKMOD_ROUTES_START';
const MARKER_END = '// STACKMOD_ROUTES_END';
const EARLY_MARKER_START = '// STACKMOD_EARLY_ROUTES_START';
const EARLY_MARKER_END = '// STACKMOD_EARLY_ROUTES_END';

// ─── Import injection ─────────────────────────────────────────────────────────

/**
 * Inject a new import statement after the last existing import line.
 * Works for both ESM (`import x from`) and CJS (`const x = require()`).
 */
function injectImportStatement(source: string, importSymbol: string, importPath: string): string {
    const importLine = `import ${importSymbol} from '${importPath}';`;
    const lines = source.split('\n');

    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trimStart();
        if (t.startsWith('import ') || (t.startsWith('const ') && t.includes('require('))) {
            lastImportIdx = i;
        }
    }

    if (lastImportIdx >= 0) {
        lines.splice(lastImportIdx + 1, 0, importLine);
    } else {
        lines.unshift(importLine);
    }

    return lines.join('\n');
}

// ─── Injection point resolver ─────────────────────────────────────────────────

/**
 * Find the best character index to insert a new route block.
 *
 * Priority hierarchy (handles cors/json/errorHandler ordering correctly):
 *   1. Start of the line that calls app.listen()  — routes go BEFORE server start
 *   2. End of the line that calls express.json()  — routes go AFTER body parsing
 *   3. End of the last named route (app.use('/…')) — routes go AFTER last peer
 *   4. End of file                                 — absolute fallback
 */
function findInjectionPoint(content: string): number {
    // Priority 1: before app.listen — routes must live before the server starts
    const listenMatch = content.match(/app\.listen\s*\(/);
    if (listenMatch?.index !== undefined) {
        // Walk back to the start of that line
        const lineStart = content.lastIndexOf('\n', listenMatch.index);
        return lineStart >= 0 ? lineStart : 0;
    }

    // Priority 2: after express.json() middleware line
    const jsonMatch = content.match(/app\.use\s*\(\s*express\.json/);
    if (jsonMatch?.index !== undefined) {
        const lineEnd = content.indexOf('\n', jsonMatch.index);
        return lineEnd >= 0 ? lineEnd + 1 : content.length;
    }

    // Priority 3: after the last named router (app.use('/…'))
    const routerMatches = [...content.matchAll(/app\.use\s*\(\s*['"`]\//g)];
    if (routerMatches.length > 0) {
        const last = routerMatches[routerMatches.length - 1];
        if (last.index !== undefined) {
            const lineEnd = content.indexOf('\n', last.index);
            return lineEnd >= 0 ? lineEnd + 1 : content.length;
        }
    }

    return content.length;
}

function findEarlyInjectionPoint(content: string): number {
    const jsonMatch = content.match(/app\.use\s*\(\s*express\.json/);
    if (jsonMatch?.index === undefined) return findInjectionPoint(content);

    const lineStart = content.lastIndexOf('\n', jsonMatch.index);
    return lineStart >= 0 ? lineStart + 1 : 0;
}

// ─── Route block injection ────────────────────────────────────────────────────

/**
 * Inject `app.use(mount, symbol)` into the STACKMOD marker block.
 *
 * If the marker block already exists, the new line is appended before MARKER_END.
 * If not, a new marker block is created at the best anchor point (before app.listen).
 */
function injectRouteStatement(
    content: string,
    mount: string,
    importSymbol: string,
    beforeBodyParser: boolean
): string {
    const useLine = `app.use('${mount}', ${importSymbol});`;
    const markerStart = beforeBodyParser ? EARLY_MARKER_START : MARKER_START;
    const markerEnd = beforeBodyParser ? EARLY_MARKER_END : MARKER_END;

    if (content.includes(markerStart)) {
        // Marker block exists — insert before the end marker
        return content.replace(markerEnd, `${useLine}\n${markerEnd}`);
    }

    // No marker yet — create one at the best anchor point
    const insertAt = beforeBodyParser
        ? findEarlyInjectionPoint(content)
        : findInjectionPoint(content);
    const markerBlock = `\n${markerStart}\n${useLine}\n${markerEnd}\n`;

    return content.slice(0, insertAt) + markerBlock + content.slice(insertAt);
}

// ─── Replit registerRoutes injection ─────────────────────────────────────────

/**
 * Inject an Express router into the Replit fullstack template's registerRoutes function.
 *
 * Phase 1 — Inject import after last import statement
 * Phase 2 — Inject app.use() before `return httpServer;`
 */
function injectReplitRoutes(
    source: string,
    importSymbol: string,
    importPath: string,
    mount: string
): string {
    // ── Guard ──────────────────────────────────────────────────────────────────
    if (source.includes(importPath)) {
        throw new Error(
            `The import "${importPath}" already exists in routes file.\n` +
            `Has this mutation already been applied?`
        );
    }

    // ── Phase 1: inject import ─────────────────────────────────────────────────
    let result = injectImportStatement(source, importSymbol, importPath);

    // ── Phase 2: inject app.use() before `return httpServer;` ─────────────────
    const useLine = `\n  app.use('${mount}', ${importSymbol});`;
    const returnMatch = result.match(/\n(\s*)return\s+httpServer\s*;/);
    if (returnMatch?.index !== undefined) {
        result =
            result.slice(0, returnMatch.index) +
            useLine + '\n' +
            result.slice(returnMatch.index + 1); // +1 to skip the \n we already added
    } else {
        result += `\n${useLine}\n`;
    }

    return result;
}

// ─── Main entry injection orchestrator ───────────────────────────────────────

/**
 * Inject an Express router into the entry file.
 *
 * Phase 1 — Check guard (already applied?)
 * Phase 2 — Inject import after last import statement
 * Phase 3 — Inject app.use() into STACKMOD marker block
 *            (creates marker before app.listen if absent)
 */
function injectExpressRouter(
    source: string,
    importSymbol: string,
    importPath: string,
    mount: string,
    beforeBodyParser: boolean
): string {
    // ── Guard ──────────────────────────────────────────────────────────────────
    if (source.includes(importPath)) {
        throw new Error(
            `The import "${importPath}" already exists in the entry file.\n` +
            `Has this mutation already been applied?`
        );
    }

    // ── Phase 1: inject import ─────────────────────────────────────────────────
    let result = injectImportStatement(source, importSymbol, importPath);

    // ── Phase 2: inject route into marker block ────────────────────────────────
    result = injectRouteStatement(result, mount, importSymbol, beforeBodyParser);

    return result;
}


// ─── Package.json updater ────────────────────────────────────────────────────

function addDependencyToPackageJson(rootDir: string, depName: string, version: string): void {
    const pkgPath = path.resolve(rootDir, 'package.json');
    const pkg = readJSON<Record<string, unknown>>(pkgPath);

    if (!pkg.dependencies || typeof pkg.dependencies !== 'object') {
        pkg.dependencies = {};
    }

    const deps = pkg.dependencies as Record<string, string>;
    if (deps[depName]) return;  // already present, skip

    deps[depName] = version;
    writeJSON(pkgPath, pkg);
}

// ─── Env example updater ──────────────────────────────────────────────────────

function addEnvExample(rootDir: string, key: string): void {
    const envExamplePath = path.resolve(rootDir, '.env.example');
    const existing = fileExists(envExamplePath) ? readFile(envExamplePath) : '';

    // Skip if already present
    if (existing.includes(`${key}=`)) return;

    const line = `${key}=your_${key.toLowerCase()}_here\n`;
    writeFile(envExamplePath, existing + line);
}

// ─── Main patcher ─────────────────────────────────────────────────────────────

export interface PatchResult {
    filesCreated: string[];   // absolute paths
    filesModified: string[];   // absolute paths
    backupDir: string;     // absolute path to backup directory
}

/**
 * Apply a PatchPlan to the filesystem.
 * Creates a backup directory before modifying any existing files.
 * The rollbackId is used to name the backup dir so rollback can always find it.
 */
export async function applyPatchPlan(
    plan: PatchPlan,
    profile: CodebaseProfile,
    rollbackId: string
): Promise<PatchResult> {
    const filesCreated = new Set<string>();
    const filesModified = new Set<string>();
    const filesBackedUp = new Set<string>();

    // ── Create backup directory named after rollbackId ─────────────────────────
    const backupDir = path.resolve(
        profile.rootDir,
        '.injext',
        'backups',
        rollbackId   // deterministic: matches the ledger entry ID exactly
    );
    fsBase.mkdirSync(backupDir, { recursive: true });

    const backupFileOnce = (filePath: string): void => {
        if (filesBackedUp.has(filePath)) return;

        const relPath = path.relative(profile.rootDir, filePath);
        const backupPath = path.join(backupDir, relPath);
        fsBase.mkdirSync(path.dirname(backupPath), { recursive: true });
        fsBase.copyFileSync(filePath, backupPath);
        filesBackedUp.add(filePath);
    };

    const restorePartialMutation = (): void => {
        for (const filePath of filesCreated) {
            if (fileExists(filePath)) fsBase.rmSync(filePath, { force: true });
        }

        for (const filePath of filesModified) {
            const relPath = path.relative(profile.rootDir, filePath);
            const backupPath = path.join(backupDir, relPath);
            if (fileExists(backupPath)) {
                fsBase.mkdirSync(path.dirname(filePath), { recursive: true });
                fsBase.copyFileSync(backupPath, filePath);
            }
        }

        fsBase.rmSync(backupDir, { recursive: true, force: true });
    };

    try {
        for (const op of plan.operations) {
            switch (op.type) {
                case 'create_file': {
                    const createOp = op as CreateFileOp;
                    if (fileExists(createOp.path)) {
                        throw new Error(
                            `File already exists: ${createOp.path}\n` +
                            `Has the "${plan.mutationId}" mutation already been applied?`
                        );
                    }
                    filesCreated.add(createOp.path);
                    writeFile(createOp.path, createOp.content);
                    break;
                }

                case 'modify_file': {
                    const modOp = op as ModifyFileOp;
                    if (!fileExists(modOp.path)) {
                        throw new Error(`Cannot modify non-existent file: ${modOp.path}`);
                    }

                    backupFileOnce(modOp.path);
                    filesModified.add(modOp.path);

                    if (modOp.modification === 'express_inject_router') {
                        const original = readFile(modOp.path);
                        const modified = injectExpressRouter(
                            original,
                            modOp.importSymbol,
                            modOp.importPath,
                            modOp.mount,
                            modOp.beforeBodyParser
                        );
                        writeFile(modOp.path, modified);
                    } else if (modOp.modification === 'replit_routes_inject') {
                        const original = readFile(modOp.path);
                        const modified = injectReplitRoutes(
                            original,
                            modOp.importSymbol,
                            modOp.importPath,
                            modOp.mount
                        );
                        writeFile(modOp.path, modified);
                    }
                    break;
                }

                case 'append_file': {
                    const appendOp = op as AppendFileOp;
                    if (!fileExists(appendOp.path)) {
                        throw new Error(`Cannot append to non-existent file: ${appendOp.path}`);
                    }
                    const appendCurrent = readFile(appendOp.path);
                    if (appendOp.guard && appendCurrent.includes(appendOp.guard)) break;

                    backupFileOnce(appendOp.path);
                    filesModified.add(appendOp.path);
                    writeFile(appendOp.path, appendCurrent + '\n' + appendOp.content);
                    break;
                }

                case 'insert_before_pattern': {
                    const insertOp = op as InsertBeforePatternOp;
                    if (!fileExists(insertOp.path)) {
                        throw new Error(`Cannot insert into non-existent file: ${insertOp.path}`);
                    }
                    const insertCurrent = readFile(insertOp.path);
                    if (insertOp.guard && insertCurrent.includes(insertOp.guard)) break;

                    const regex = new RegExp(insertOp.pattern, 'm');
                    const match = regex.exec(insertCurrent);
                    if (!match || match.index === undefined) {
                        throw new Error(`Pattern "${insertOp.pattern}" not found in ${insertOp.path}`);
                    }

                    backupFileOnce(insertOp.path);
                    filesModified.add(insertOp.path);
                    const lineStart = insertCurrent.lastIndexOf('\n', match.index);
                    const insertAt = lineStart >= 0 ? lineStart : 0;
                    const insertModified =
                        insertCurrent.slice(0, insertAt) +
                        '\n' + insertOp.content +
                        insertCurrent.slice(insertAt);
                    writeFile(insertOp.path, insertModified);
                    break;
                }

                case 'add_dependency': {
                    const depOp = op as AddDependencyOp;
                    const packagePath = path.resolve(profile.rootDir, 'package.json');
                    backupFileOnce(packagePath);
                    filesModified.add(packagePath);
                    addDependencyToPackageJson(profile.rootDir, depOp.name, depOp.version);
                    break;
                }

                case 'add_env': {
                    const envPath = path.resolve(profile.rootDir, '.env.example');
                    if (filesCreated.has(envPath)) {
                        addEnvExample(profile.rootDir, op.key);
                    } else if (fileExists(envPath)) {
                        backupFileOnce(envPath);
                        filesModified.add(envPath);
                        addEnvExample(profile.rootDir, op.key);
                    } else {
                        filesCreated.add(envPath);
                        addEnvExample(profile.rootDir, op.key);
                    }
                    break;
                }
            }
        }
    } catch (error) {
        restorePartialMutation();
        throw error;
    }

    return {
        filesCreated: [...filesCreated],
        filesModified: [...filesModified],
        backupDir,
    };
}

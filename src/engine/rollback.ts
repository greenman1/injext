import * as path from 'path';
import * as fsBase from 'fs';
import { fileExists, deleteFile } from '../utils/fs';
import { findEntryById, removeLedgerEntry } from './ledger';

function resolveProjectPath(rootDir: string, storedPath: string, label: string): string {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedPath = path.isAbsolute(storedPath)
        ? path.resolve(storedPath)
        : path.resolve(resolvedRoot, storedPath);
    const relative = path.relative(resolvedRoot, resolvedPath);

    if (
        relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`Refusing to use ${label} outside the project: ${storedPath}`);
    }

    return resolvedPath;
}

/**
 * Roll back a previously applied mutation.
 *
 * Strategy:
 *  1. Delete all files the mutation created
 *  2. Restore all files the mutation modified from entry.backup_dir
 *  3. Remove the ledger entry
 */
export async function rollbackMutation(
    rootDir: string,
    rollbackId: string
): Promise<void> {
    // ── 1. Find ledger entry ───────────────────────────────────────────────────
    const entry = findEntryById(rootDir, rollbackId);
    if (!entry) {
        throw new Error(
            `No ledger entry found for rollback ID: "${rollbackId}"\n` +
            `Run "stackmod history" to list available rollback IDs.`
        );
    }

    // Resolve and validate every stored path before making any changes. Relative
    // paths are the current format; absolute paths support older local ledgers.
    const backupDir = resolveProjectPath(rootDir, entry.backup_dir, 'backup path');
    const createdPaths = entry.files_created.map(filePath =>
        resolveProjectPath(rootDir, filePath, 'created-file path')
    );
    const modifiedPaths = entry.files_modified.map(filePath =>
        resolveProjectPath(rootDir, filePath, 'modified-file path')
    );

    // ── 3. Delete created files ────────────────────────────────────────────────
    const notDeleted: string[] = [];
    for (const absPath of createdPaths) {
        if (fileExists(absPath)) {
            deleteFile(absPath);
        } else {
            notDeleted.push(absPath);
        }
    }

    // ── 4. Restore modified files from backup ─────────────────────────────────
    const notRestored: string[] = [];
    for (const absPath of modifiedPaths) {
        if (!backupDir || !fsBase.existsSync(backupDir)) {
            notRestored.push(absPath);
            continue;
        }

        const relPath = path.relative(rootDir, absPath);
        const backupFile = path.join(backupDir, relPath);

        if (fileExists(backupFile)) {
            fsBase.mkdirSync(path.dirname(absPath), { recursive: true });
            fsBase.copyFileSync(backupFile, absPath);
        } else {
            notRestored.push(absPath);
        }
    }

    // ── 5. Remove ledger entry ─────────────────────────────────────────────────
    removeLedgerEntry(rootDir, rollbackId);

    // ── 6. Report warnings ─────────────────────────────────────────────────────
    if (notDeleted.length > 0) {
        console.warn(
            `\n⚠  These files were already missing (skipped delete):\n` +
            notDeleted.map(f => `   ${f}`).join('\n')
        );
    }
    if (notRestored.length > 0) {
        console.warn(
            `\n⚠  Could not restore these files (backup missing):\n` +
            notRestored.map(f => `   ${f}`).join('\n')
        );
    }
}

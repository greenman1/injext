import * as path from 'path';
import { Ledger, LedgerEntry } from './profile';
import { fileExists, readJSON, writeJSON, ensureDir, writeFile } from '../utils/fs';

const LEDGER_FILENAME = 'ledger.json';
const STATE_IGNORE = '*\n!.gitignore\n';

function getLedgerPath(rootDir: string): string {
    return path.resolve(rootDir, '.injext', LEDGER_FILENAME);
}

// ─── Load / Save ──────────────────────────────────────────────────────────────

export function loadLedger(rootDir: string): Ledger {
    const ledgerPath = getLedgerPath(rootDir);
    if (!fileExists(ledgerPath)) {
        return { entries: [] };
    }
    return readJSON<Ledger>(ledgerPath);
}

function saveLedger(rootDir: string, ledger: Ledger): void {
    const ledgerPath = getLedgerPath(rootDir);
    ensureDir(path.dirname(ledgerPath));
    writeFile(path.resolve(rootDir, '.injext', '.gitignore'), STATE_IGNORE);
    writeJSON(ledgerPath, ledger);
}

function toPortableProjectPath(rootDir: string, filePath: string): string {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedPath = path.resolve(filePath);
    const relative = path.relative(resolvedRoot, resolvedPath);

    if (
        relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`Refusing to record a path outside the project: ${filePath}`);
    }

    return relative.split(path.sep).join('/');
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Returns the ledger entry for a mutation if it has already been applied. */
export function findAppliedMutation(rootDir: string, mutationId: string): LedgerEntry | null {
    const ledger = loadLedger(rootDir);
    return ledger.entries.find(e => e.mutation === mutationId) ?? null;
}

/** Find a ledger entry by its rollback ID. */
export function findEntryById(rootDir: string, rollbackId: string): LedgerEntry | null {
    const ledger = loadLedger(rootDir);
    return ledger.entries.find(e => e.id === rollbackId) ?? null;
}

/** List all ledger entries. */
export function listEntries(rootDir: string): LedgerEntry[] {
    return loadLedger(rootDir).entries;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/** Record a new mutation in the ledger. Returns the created entry. */
export function recordMutation(
    rootDir: string,
    mutationId: string,
    version: string,
    filesCreated: string[],
    filesModified: string[],
    backupDir: string,
    rollbackId: string
): LedgerEntry {
    const ledger = loadLedger(rootDir);

    const entry: LedgerEntry = {
        id: rollbackId,
        mutation: mutationId,
        version,
        applied_at: new Date().toISOString(),
        files_created: filesCreated.map(filePath => toPortableProjectPath(rootDir, filePath)),
        files_modified: filesModified.map(filePath => toPortableProjectPath(rootDir, filePath)),
        backup_dir: toPortableProjectPath(rootDir, backupDir),
    };

    ledger.entries.push(entry);
    saveLedger(rootDir, ledger);

    return entry;
}


/** Remove a ledger entry by ID (called after successful rollback). */
export function removeLedgerEntry(rootDir: string, rollbackId: string): void {
    const ledger = loadLedger(rootDir);
    ledger.entries = ledger.entries.filter(e => e.id !== rollbackId);
    saveLedger(rootDir, ledger);
}

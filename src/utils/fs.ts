import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Safe file helpers ────────────────────────────────────────────────────────

export function fileExists(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function dirExists(dirPath: string): boolean {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
}

export function readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

export function writeFile(filePath: string, content: string): void {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf8');
}

export function copyFile(src: string, dest: string): void {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

export function deleteFile(filePath: string): void {
    if (fileExists(filePath)) {
        fs.unlinkSync(filePath);
    }
}

export function ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function readJSON<T>(filePath: string): T {
    const raw = readFile(filePath);
    return JSON.parse(raw) as T;
}

export function writeJSON(filePath: string, data: unknown, pretty = true): void {
    const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    writeFile(filePath, content + '\n');
}

// ─── Find files ───────────────────────────────────────────────────────────────

/**
 * Find the first file from a list of candidates that exists under rootDir.
 * Paths are relative to rootDir.
 */
export function findFirstExisting(rootDir: string, candidates: string[]): string | null {
    for (const candidate of candidates) {
        const resolved = path.resolve(rootDir, candidate);
        if (fileExists(resolved)) return resolved;
    }
    return null;
}

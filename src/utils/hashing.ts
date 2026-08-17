import * as crypto from 'crypto';
import * as fs from 'fs';

/** SHA-256 hash of a string, returned as hex */
export function sha256(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 hash of a file's contents */
export function sha256File(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/** Generate a short timestamp-based ID */
export function timestampId(prefix: string): string {
    return `${prefix}-${Date.now()}`;
}

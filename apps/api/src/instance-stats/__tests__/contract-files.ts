import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

/** The vendored contract directory (`packages/agent/src/ever-instance/contract`). */
export const CONTRACT_DIR = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'agent',
    'src',
    'ever-instance',
    'contract',
);

export function contractBytes(relative: string): Buffer {
    return readFileSync(join(CONTRACT_DIR, relative));
}

export function contractJson<T = unknown>(relative: string): T {
    return JSON.parse(contractBytes(relative).toString('utf8')) as T;
}

export function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export interface VendorRecord {
    repository: string;
    commit: string;
    schema: { path: string; source: string; sha256: string };
    fixtures: Array<{ path: string; source: string; sha256: string }>;
}

export interface ExpectedRecord {
    fixtures: Record<
        string,
        { status: number; code?: string; path?: string; layer: 'schema' | 'ingest'; reason: string }
    >;
}

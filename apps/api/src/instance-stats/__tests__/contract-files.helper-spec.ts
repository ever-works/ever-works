import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * The installed `@ever-co/connect-contracts` package: the published
 * `ever.stats.v1` schema (`schemas/`) and its shared fixtures (`fixtures/`).
 * Nothing of the contract is copied into this repository.
 */
export const CONTRACT_DIR = dirname(require.resolve('@ever-co/connect-contracts/package.json'));

/** The statistics fixtures of the package (`valid/`, `invalid/`, `expected.json`). */
export const STATS_FIXTURES_DIR = join(CONTRACT_DIR, 'fixtures', 'stats');

export function contractBytes(relative: string): Buffer {
    return readFileSync(join(CONTRACT_DIR, relative));
}

export function contractJson<T = unknown>(relative: string): T {
    return JSON.parse(contractBytes(relative).toString('utf8')) as T;
}

export function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export interface ExpectedRecord {
    fixtures: Record<
        string,
        {
            status: number;
            code?: string;
            path?: string;
            error?: string;
            layer: 'schema' | 'ingest';
            reason: string;
        }
    >;
}

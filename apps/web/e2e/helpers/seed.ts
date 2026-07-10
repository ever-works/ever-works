import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * E2E seed metadata written by `global-setup.ts` and read by specs that
 * need a real seeded tenant (TENANT_ID + webhook secret + optional
 * no-secret tenant). Specs read this through `loadSeed()` so they
 * inherit the seeded state without per-spec API choreography.
 *
 * The shape is duplicated as plain fields for direct JSON consumption;
 * env vars override the seed file when explicitly exported.
 */
export interface E2ESeed {
    apiBase: string;
    tenantId: string;
    webhookSecret: string;
    tenantIdNoSecret?: string;
    primaryUser: { email: string; password: string; username: string };
    secondaryUser?: { email: string; password: string; username: string };
    generatedAt: string;
}

export const SEED_PATH = 'e2e/.auth/seed.json';

export function writeSeed(seed: E2ESeed, path: string = SEED_PATH): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(seed, null, 2), 'utf8');
}

/**
 * Load seed metadata for a spec. Returns null when the file is absent —
 * specs use this to skip with a clear message rather than throw.
 *
 * Env vars take precedence over the file's defaults so a CI shard can
 * override TEST_TENANT_ID / TEST_TRIGGER_WEBHOOK_SECRET without
 * regenerating the file.
 */
export function loadSeed(path: string = SEED_PATH): E2ESeed | null {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return null;
    }
    let parsed: E2ESeed;
    try {
        parsed = JSON.parse(raw) as E2ESeed;
    } catch {
        return null;
    }
    return {
        apiBase: process.env.PLAYWRIGHT_API_BASE_URL ?? parsed.apiBase,
        tenantId: process.env.TEST_TENANT_ID || parsed.tenantId,
        webhookSecret: process.env.TEST_TRIGGER_WEBHOOK_SECRET || parsed.webhookSecret,
        tenantIdNoSecret: process.env.TEST_TENANT_ID_NO_SECRET || parsed.tenantIdNoSecret,
        primaryUser: parsed.primaryUser,
        secondaryUser: parsed.secondaryUser,
        generatedAt: parsed.generatedAt,
    };
}

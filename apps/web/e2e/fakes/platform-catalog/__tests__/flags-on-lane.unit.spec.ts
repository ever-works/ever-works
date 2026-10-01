/**
 * The flags-on e2e job, read from `.github/workflows/e2e.yml` itself.
 *
 * Owner decision (2026-09-25): ACC-E2E-12 (`e2e/flow-app-launcher-apps.spec.ts`, "with the
 * launcher enabled") and ACC-REG-05's cap (`e2e/flow-managed-subdomain-allocation.spec.ts`,
 * `DEPLOY_EVER_WORKS_ENABLED=true`) run on a SECOND, single-shard job with both switches on,
 * backed by this directory's catalog fixture — while the 32-shard matrix keeps both switches
 * off, because `e2e/flow-deploy-capability-contract.spec.ts` asserts the switch-off behaviour
 * there. The two files skip by name on the matrix, so the second job is the only place they
 * run. That makes four facts load-bearing, and nothing but this spec checks them before a run
 * is dispatched:
 *
 *   1. the matrix still has both switches off;
 *   2. the second job is the matrix's stack plus a named set of deltas and NOTHING else — a job
 *      that quietly drifts from the matrix's env proves the files pass on a stack nobody runs;
 *   3. the API is pointed at the port this directory's server actually listens on, with the
 *      fakes switch that override is gated on, and the lane marker that turns a switch-off
 *      skip into a failure is set;
 *   4. the job's apps apex is one `config.everWorks.apps.getDomain()` accepts, so the launcher
 *      cases keep their address when APW-06 T48 binds the resolver that reads that getter.
 *
 * This file runs in the harness unit lane (`pnpm --filter ever-works-web test:e2e-harness`),
 * which CI runs in `ci.yml`'s `lint-and-test` job.
 *
 * `apps/web` has no YAML parser dependency, so the reader below is a deliberately small
 * reader of the one shape GitHub Actions uses here (two-space job keys, `- name:` steps, a
 * step `env:` of scalar values). Every lookup that finds nothing throws, and the first case
 * asserts values the matrix is known to carry, so a parser that silently reads nothing cannot
 * pass this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, PORT_ENV } from '../server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');

const MATRIX_JOB = 'e2e';
const FLAGS_ON_JOB = 'e2e-app-works-flags-on';

/** The two files the job exists to run, as the job names them (relative to `apps/web`). */
const FLAGS_ON_FILES = [
    'e2e/flow-app-launcher-apps.spec.ts',
    'e2e/flow-managed-subdomain-allocation.spec.ts',
];

/**
 * Everything the second job's env may add to the matrix's — each one named, and nothing the
 * matrix sets may be changed or dropped.
 */
const FLAGS_ON_DELTAS: Record<string, string> = {
    // The two switches the owner decision turns on.
    EVER_WORKS_APP_LAUNCHER_ENABLED: 'true',
    DEPLOY_EVER_WORKS_ENABLED: 'true',
    // The apex a launcher tile's managed address is derived under (`managed-host-root.resolver.ts`);
    // without it a seeded App Work has no address and is `notLive`. It is a sibling of the
    // platform domain, not a subdomain: `config.everWorks.apps.getDomain()` refuses the nested
    // `apps.e2e.local` (see the last describe block below).
    EVER_WORKS_APPS_DOMAIN: 'apps-e2e.local',
    EVER_WORKS_DOMAIN: 'e2e.local',
    // The catalog fixture this directory serves, and the environment whose addresses it reads.
    EVER_WORKS_PLATFORM_CATALOG_BASE_URL: `http://127.0.0.1:${DEFAULT_PORT}`,
    EVER_WORKS_PLATFORM_CATALOG_ENV: 'develop',
    // The marker that turns a switch-off skip into a failure in the two files.
    APW_E2E_FLAGS_ON_LANE: '1',
};

// ---------------------------------------------------------------------------
// A small reader for this workflow's shape
// ---------------------------------------------------------------------------

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

function isContent(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
}

/** The lines of one job, from its `  <name>:` key to the next job key. */
function jobLines(source: string, job: string): string[] {
    const lines = source.split(/\r?\n/);
    const jobsAt = lines.findIndex((line) => line === 'jobs:');
    if (jobsAt === -1) throw new Error('e2e.yml has no top-level `jobs:` key');
    const start = lines.findIndex((line, index) => index > jobsAt && line === `  ${job}:`);
    if (start === -1) throw new Error(`e2e.yml has no job \`${job}\``);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (isContent(line) && indentOf(line) <= 2) {
            end = index;
            break;
        }
    }
    return lines.slice(start + 1, end);
}

/** The keys directly under a mapping key at `indent` (e.g. `    services:` → its children). */
function childKeys(lines: string[], key: string, indent: number): string[] {
    const at = lines.findIndex((line) => line === `${' '.repeat(indent)}${key}:`);
    if (at === -1) return [];
    const keys: string[] = [];
    for (let index = at + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!isContent(line)) continue;
        if (indentOf(line) <= indent) break;
        const match = new RegExp(`^ {${indent + 2}}([A-Za-z0-9_-]+):`).exec(line);
        if (match) keys.push(match[1]);
    }
    return keys;
}

/** Each `      - name:` step of a job, as its own slice of lines. */
function steps(lines: string[]): string[][] {
    const result: string[][] = [];
    let current: string[] | null = null;
    for (const line of lines) {
        if (/^ {6}- /.test(line)) {
            current = [line];
            result.push(current);
        } else if (current) {
            current.push(line);
        }
    }
    return result;
}

/** The block-scalar body of a step key such as `run: |`, de-indented. */
function blockScalar(step: string[], key: string): string {
    const at = step.findIndex((line) => new RegExp(`^ {8}${key}: [|>]-?\\s*$`).test(line));
    if (at === -1) return '';
    const body: string[] = [];
    for (let index = at + 1; index < step.length; index += 1) {
        const line = step[index];
        if (line.trim().length > 0 && indentOf(line) <= 8) break;
        body.push(line.slice(10));
    }
    return body.join('\n');
}

/** The step that runs Playwright — the one whose env is the lane's stack. */
function playwrightStep(lines: string[], job: string): string[] {
    const found = steps(lines).filter((step) =>
        blockScalar(step, 'run').includes('pnpm exec playwright test'),
    );
    if (found.length !== 1) {
        throw new Error(`job \`${job}\` has ${found.length} steps running Playwright, not one`);
    }
    return found[0];
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
    return trimmed.replace(/\s+#.*$/, '');
}

/** A step's `env:` as `{ KEY: value }`; a block scalar value is kept as its joined body. */
function stepEnv(step: string[]): Record<string, string> {
    const at = step.findIndex((line) => /^ {8}env:\s*$/.test(line));
    if (at === -1) throw new Error('the step has no `env:` block');
    const env: Record<string, string> = {};
    let blockKey: string | null = null;
    let block: string[] = [];
    const flush = () => {
        if (blockKey) env[blockKey] = block.join('\n');
        blockKey = null;
        block = [];
    };
    for (let index = at + 1; index < step.length; index += 1) {
        const line = step[index];
        if (!isContent(line)) continue;
        const indent = indentOf(line);
        if (indent <= 8) break;
        if (blockKey && indent > 10) {
            block.push(line.trim());
            continue;
        }
        flush();
        const match = /^ {10}([A-Z0-9_]+):\s*(.*)$/.exec(line);
        if (!match) throw new Error(`unreadable env line: ${line.trim()}`);
        if (/^[|>]-?$/.test(match[2].trim())) {
            blockKey = match[1];
        } else {
            env[match[1]] = unquote(match[2]);
        }
    }
    flush();
    return env;
}

// ---------------------------------------------------------------------------
// What `config.everWorks.apps.getDomain()` answers for an env
// ---------------------------------------------------------------------------

/**
 * `normalizeApexDomain` in `packages/agent/src/config/index.ts`: a plain dotted DNS name,
 * lowercased with the root dot stripped, or `null`.
 */
function normalizeApex(raw: string | undefined): string | null {
    const text = (raw ?? '').trim().toLowerCase();
    const apex = text.endsWith('.') ? text.slice(0, -1) : text;
    if (apex.length === 0 || apex.length > 253 || !/^[a-z0-9.-]+$/.test(apex)) return null;
    if (/^\d+(\.\d+){3}$/.test(apex)) return null;
    const labels = apex.split('.');
    if (labels.length < 2) return null;
    const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
    return labels.every((part) => part.length <= 63 && label.test(part)) ? apex : null;
}

/** The host of a platform URL, as `platformManagedDomainHosts` reads it, or `null`. */
function hostOf(raw: string | undefined): string | null {
    try {
        return normalizeApex(new URL((raw ?? '').trim()).hostname);
    } catch {
        return null;
    }
}

/**
 * What `config.everWorks.apps.getDomain()` answers for `env`, restated because `apps/web`
 * does not depend on `@ever-works/agent`. The two branches are the agent's own: unset means
 * the platform domain (`EVER_WORKS_DOMAIN`, default `ever.works`); an explicit apex is refused
 * (`null`) when it is equal to, under, or a parent of the platform domain or of the host of
 * `PLATFORM_API_URL` / `NEXT_PUBLIC_APP_URL` (`appsDomainClash`). The first case in the
 * domain block pins this copy against the agent's own `config.spec.ts` cases.
 */
function getDomainWouldAnswer(env: Record<string, string | undefined>): string | null {
    const platformRaw = (env.EVER_WORKS_DOMAIN ?? '').trim();
    const platform = platformRaw.length === 0 ? 'ever.works' : normalizeApex(platformRaw);
    if (platform === null) return null;
    if ((env.EVER_WORKS_APPS_DOMAIN ?? '').trim().length === 0) return platform;

    const apex = normalizeApex(env.EVER_WORKS_APPS_DOMAIN);
    if (apex === null) return null;
    const hosts = [platform, hostOf(env.PLATFORM_API_URL), hostOf(env.NEXT_PUBLIC_APP_URL)];
    for (const host of hosts) {
        if (host === null) continue;
        if (apex === host || apex.endsWith(`.${host}`) || host.endsWith(`.${apex}`)) return null;
    }
    return apex;
}

/**
 * What the launcher's bound default, `DefaultManagedHostRootResolver`, answers for a kind-`app`
 * Work today: the raw `EVER_WORKS_APPS_DOMAIN`, else `EVER_WORKS_DOMAIN`, else `null`. It is
 * also how `flow-app-launcher-apps.spec.ts`'s `managedRoot()` derives the tile URL it asserts.
 */
function defaultResolverAppRoot(env: Record<string, string | undefined>): string | null {
    const apps = (env.EVER_WORKS_APPS_DOMAIN ?? '').trim();
    if (apps.length > 0) return apps;
    const domain = (env.EVER_WORKS_DOMAIN ?? '').trim();
    return domain.length > 0 ? domain : null;
}

const source = fs.readFileSync(WORKFLOW, 'utf8');

function job(name: string) {
    const lines = jobLines(source, name);
    const step = playwrightStep(lines, name);
    return { lines, step, env: stepEnv(step), run: blockScalar(step, 'run') };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe('e2e.yml — the sharded matrix keeps both switches off', () => {
    it('reads the matrix env it is known to carry (the reader is not reading nothing)', () => {
        const matrix = job(MATRIX_JOB);
        expect(matrix.env.E2E_APP_LAUNCHER_SEED).toBe('true');
        expect(matrix.env.EVER_WORKS_E2E_FAKES).toBe('1');
        expect(matrix.env.APW_E2E_GITHUB_FAKE_URL).toBe('http://127.0.0.1:3900');
        expect(matrix.env.GITHUB_APP_PRIVATE_KEY).toContain('BEGIN RSA PRIVATE KEY');
        expect(matrix.run).toContain('--shard=${{ matrix.shard }}/32');
    });

    it('sets neither switch, nor any other flags-on delta, on the matrix', () => {
        const matrix = job(MATRIX_JOB);
        for (const key of Object.keys(FLAGS_ON_DELTAS)) {
            expect(
                matrix.env[key],
                `${key} on the matrix would flip flow-deploy-capability-contract's switch-off ` +
                    'assertions, or un-skip the two flags-on files on a stack without their fixture',
            ).toBeUndefined();
        }
    });
});

describe('e2e.yml — the flags-on job', () => {
    it('is one shard that runs exactly the two flag-on files, and both files exist', () => {
        const flagsOn = job(FLAGS_ON_JOB);
        expect(
            childKeys(flagsOn.lines, 'matrix', 6),
            'no shard axis — the job is a single runner',
        ).not.toContain('shard');
        expect(flagsOn.run).not.toContain('--shard');
        const invocation = flagsOn.run
            .split('\n')
            .find((line) => line.includes('pnpm exec playwright test'));
        expect(invocation?.trim()).toBe(`pnpm exec playwright test ${FLAGS_ON_FILES.join(' ')}`);
        for (const file of FLAGS_ON_FILES) {
            expect(fs.existsSync(path.join(WEB_ROOT, file)), file).toBe(true);
        }
    });

    it('runs on the matrix’s stack plus the named deltas — nothing changed, nothing dropped', () => {
        const matrix = job(MATRIX_JOB);
        const flagsOn = job(FLAGS_ON_JOB);

        const added = Object.keys(flagsOn.env).filter((key) => !(key in matrix.env));
        expect(added.sort(), 'every addition is a named delta').toEqual(
            Object.keys(FLAGS_ON_DELTAS).sort(),
        );
        for (const [key, value] of Object.entries(FLAGS_ON_DELTAS)) {
            expect(flagsOn.env[key], key).toBe(value);
        }
        for (const [key, value] of Object.entries(matrix.env)) {
            expect(flagsOn.env[key], `${key} must match the matrix`).toBe(value);
        }
        expect(
            childKeys(flagsOn.lines, 'services', 4).sort(),
            'the env points REDIS_URL and SMTP_HOST at the matrix’s service containers',
        ).toEqual(childKeys(matrix.lines, 'services', 4).sort());
    });

    it('boots the matrix’s processes plus the catalog fake, and the API reaches that fake', () => {
        const matrix = job(MATRIX_JOB);
        const flagsOn = job(FLAGS_ON_JOB);

        for (const process of [
            'node e2e/fakes/github-fake/server.mjs',
            'app-runtime:local-worker',
            'pnpm --filter ever-works-api start:prod',
            'pnpm --filter ever-works-web start',
        ]) {
            expect(matrix.run, `the matrix boots ${process}`).toContain(process);
            expect(flagsOn.run, `the flags-on job boots ${process} too`).toContain(process);
        }
        expect(flagsOn.run).toContain('node e2e/fakes/platform-catalog/server.mjs');
        expect(
            flagsOn.run,
            'the job waits for the catalog fake on the port the API is pointed at',
        ).toContain(`http://127.0.0.1:${DEFAULT_PORT}/_control/health`);
        expect(
            flagsOn.env[PORT_ENV],
            'the fake listens on its default port; the base URL above assumes it',
        ).toBeUndefined();
        expect(
            flagsOn.run.indexOf('e2e/fakes/platform-catalog/server.mjs'),
            'the catalog fake is up before the API starts (its first catalog read must reach it)',
        ).toBeLessThan(flagsOn.run.indexOf('start:prod'));

        // The override is honoured only outside production and with the fakes switch on
        // (`PlatformCatalogService.catalogBaseUrl`).
        expect(flagsOn.env.EVER_WORKS_E2E_FAKES).toBe('1');
        expect(flagsOn.env.NODE_ENV).not.toBe('production');
    });
});

/**
 * The launcher reads a kind-`app` Work's managed root through `MANAGED_HOST_ROOT_RESOLVER`.
 * Today the default resolver reads the raw env. APW-06 T48 binds
 * `AppManagedHostRootResolver`, which answers `config.everWorks.apps.getDomain()`. An apex that
 * getter refuses works now and loses the seeded Work's address once T48 lands, which turns
 * ACC-E2E-12 red on this job. So the job's apex must be one the getter accepts. It must also
 * be a dedicated apex, distinct from the platform domain, so that the tile URL the launcher
 * file asserts proves the kind-`app` branch chose the apps apex.
 */
describe('e2e.yml — the flags-on job’s apps apex survives config.everWorks.apps.getDomain()', () => {
    it('restates the getter’s own cases (packages/agent/src/config/config.spec.ts)', () => {
        expect(getDomainWouldAnswer({})).toBe('ever.works');
        expect(getDomainWouldAnswer({ EVER_WORKS_DOMAIN: 'preview.ever.works' })).toBe(
            'preview.ever.works',
        );
        expect(getDomainWouldAnswer({ EVER_WORKS_APPS_DOMAIN: 'apps.example.com' })).toBe(
            'apps.example.com',
        );
        expect(getDomainWouldAnswer({ EVER_WORKS_APPS_DOMAIN: '  Apps.Example.COM.  ' })).toBe(
            'apps.example.com',
        );
        // Equal to, under, and a parent of the platform domain, and a platform URL's host.
        for (const env of [
            { EVER_WORKS_DOMAIN: 'ever.works', EVER_WORKS_APPS_DOMAIN: 'ever.works' },
            { EVER_WORKS_DOMAIN: 'ever.works', EVER_WORKS_APPS_DOMAIN: 'apps.ever.works' },
            { EVER_WORKS_DOMAIN: 'apps.ever.works', EVER_WORKS_APPS_DOMAIN: 'ever.works' },
            { PLATFORM_API_URL: 'https://api.ever.team', EVER_WORKS_APPS_DOMAIN: 'api.ever.team' },
            {
                NEXT_PUBLIC_APP_URL: 'https://app.ever.team',
                EVER_WORKS_APPS_DOMAIN: 'app.ever.team',
            },
            // The pair this job carried until 2026-09-26.
            { EVER_WORKS_DOMAIN: 'e2e.local', EVER_WORKS_APPS_DOMAIN: 'apps.e2e.local' },
        ]) {
            expect(getDomainWouldAnswer(env), JSON.stringify(env)).toBeNull();
        }
        for (const bad of [
            'https://apps.example.com',
            'apps.example.com:8443',
            'localhost',
            '203.0.113.7',
        ]) {
            expect(getDomainWouldAnswer({ EVER_WORKS_APPS_DOMAIN: bad }), bad).toBeNull();
        }
        expect(getDomainWouldAnswer({ EVER_WORKS_DOMAIN: 'https://ever.works' })).toBeNull();
    });

    it('is a dedicated apex the getter accepts, and the getter and today’s resolver agree on it', () => {
        const flagsOn = job(FLAGS_ON_JOB);
        const today = defaultResolverAppRoot(flagsOn.env);

        expect(
            today,
            'without an apex a seeded App Work has no address and is `notLive`',
        ).not.toBeNull();
        expect(
            getDomainWouldAnswer(flagsOn.env),
            `EVER_WORKS_APPS_DOMAIN=${flagsOn.env.EVER_WORKS_APPS_DOMAIN} with ` +
                `EVER_WORKS_DOMAIN=${flagsOn.env.EVER_WORKS_DOMAIN}: config.everWorks.apps.getDomain() ` +
                'must answer the same root the default resolver does, or the launcher cases lose ' +
                'their address when APW-06 T48 binds AppManagedHostRootResolver',
        ).toBe(today);
        expect(
            flagsOn.env.EVER_WORKS_APPS_DOMAIN,
            'a dedicated apex, so the asserted tile URL tells the apps apex from the platform domain',
        ).toBeTruthy();
    });
});

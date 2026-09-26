/**
 * Unit spec for the GitHub estate helper (APW-13 T9).
 *
 * Covers the two halves T9 asks for (`tasks.md:147-152`):
 *
 *   1. **The exported surface contains no removal.** ACC-13-17's static half
 *      (`spec.md:551`) is enforced twice: over the module's *real* export
 *      surface (a runtime inspection of the namespace object, so a re-export or
 *      a renamed binding cannot hide behind a source-text scan), and over the
 *      lane code itself — a real `node:fs` walk of `apps/web/e2e/**` that looks
 *      for a removal verb aimed at a repository root, and for the estate-wide
 *      repository-removal call by name. The walk carries a control assertion
 *      (it must have visited this spec and the module under test), because a
 *      scan that silently walks nothing proves nothing.
 *   2. **`generateFromTemplate` always sends `include_all_branches: true`**, so
 *      the fixture's `variant/*` branches travel with the copy (FR-60, T68 —
 *      `tasks.md:142`). Asserted on the captured request body through a stub
 *      `fetch`, including when the caller passes `includeAllBranches: false`.
 *
 * The deletion verb and the repository path are assembled from fragments at
 * runtime rather than written literally, so this spec can be walked by its own
 * scan without becoming a finding.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as estate from '../github-estate';

const HTTP_DELETION_VERB = 'DE' + 'LETE';
const REPO_OWNER_NAME_CALL = 'delete' + 'Repository';

/** `apps/web/e2e`, resolved from this file: `helpers/__tests__/` is two up. */
const E2E_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MODULE_PATH = resolve(fileURLToPath(new URL('../github-estate.ts', import.meta.url)));
const THIS_SPEC_PATH = fileURLToPath(import.meta.url);

/** Source extensions the harness's lane code is written in. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js']);

function walkSourceFiles(root: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            found.push(...walkSourceFiles(path));
            continue;
        }
        if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(path);
    }
    return found;
}

/**
 * A deletion site is the HTTP deletion verb — quoted, or as a method-call form
 * — within 200 characters of a path that stops at the repository root, i.e.
 * `/repos/<owner>/<repo>` with nothing after it. A path carrying a further
 * segment is a documented sub-resource route (the fake's route table has a
 * hook-removal route, plan §8.3, `plan.md:525`) and is not repository deletion,
 * so it is deliberately not a site.
 */
function repositoryDeletionSites(source: string): string[] {
    const sites: string[] = [];
    const verb = new RegExp(`['"\`]${HTTP_DELETION_VERB}['"\`]|\\.de${'lete'}\\s*\\(`);
    const repositoryPath = new RegExp(`\\/re${'pos\\/'}([^\\s'\`"()]*)`, 'g');
    for (const match of source.matchAll(repositoryPath)) {
        const segments = (match[1] ?? '').split('/').filter((segment) => segment.length > 0);
        if (segments.length > 2) continue;
        const start = Math.max(0, (match.index ?? 0) - 200);
        const end = Math.min(source.length, (match.index ?? 0) + match[0].length + 200);
        const window = source.slice(start, end);
        if (verb.test(window)) sites.push(match[0]);
    }
    return sites;
}

function stubFetch(status = 201, payload: unknown = { full_name: 'org/copy' }) {
    const stub = vi.fn(
        async (_url: string, _init?: RequestInit): Promise<Response> =>
            new Response(JSON.stringify(payload), {
                status,
                headers: { 'content-type': 'application/json' },
            }),
    );
    vi.stubGlobal('fetch', stub);
    return stub;
}

function bodyOf(stub: ReturnType<typeof stubFetch>, call = 0): Record<string, unknown> {
    const init = stub.mock.calls[call]?.[1];
    return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

function urlOf(stub: ReturnType<typeof stubFetch>, call = 0): string {
    return String(stub.mock.calls[call]?.[0] ?? '');
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('github-estate: the export surface cannot remove anything (ACC-13-17)', () => {
    const removalNames = Object.entries(estate)
        .filter(([, value]) => typeof value === 'function')
        .map(([name, value]) => `${name}/${(value as { name?: string }).name ?? ''}`)
        .filter((names) => /delete|remove|destroy/i.test(names));

    it('exports no function named for a deletion', () => {
        expect(removalNames).toEqual([]);
    });

    it('exports exactly the nine estate operations of T9', () => {
        const exported = Object.entries(estate)
            .filter(([, value]) => typeof value === 'function')
            .map(([name]) => name)
            .sort();
        expect(exported).toEqual(
            [
                'archiveAndLabel',
                'closePullRequest',
                'generateFromTemplate',
                'getActionsPermissions',
                'getRepo',
                'getUserPermission',
                'listPulls',
                'listWorkflowRuns',
                'pushCommit',
            ].sort(),
        );
    });

    it('builds no deletion verb anywhere in its own source', () => {
        const source = readFileSync(MODULE_PATH, 'utf8');
        expect(source).not.toContain(HTTP_DELETION_VERB);
        expect(repositoryDeletionSites(source)).toEqual([]);
    });

    it('finds no repository deletion anywhere under apps/web/e2e (source scan)', () => {
        const files = walkSourceFiles(E2E_ROOT);

        // Control: the walk really covered the harness, including this spec and
        // the module under test — an empty walk would make the assertions below
        // vacuous.
        expect(files.length).toBeGreaterThan(10);
        const relatives = files.map((file) => relative(E2E_ROOT, file).replace(/\\/g, '/'));
        expect(relatives).toContain('helpers/github-estate.ts');
        expect(relatives).toContain('helpers/__tests__/github-estate.unit.spec.ts');
        expect(statSync(MODULE_PATH).isFile()).toBe(true);

        const deletionSites = files
            .map((file) => ({
                file: relative(E2E_ROOT, file).replace(/\\/g, '/'),
                sites: repositoryDeletionSites(readFileSync(file, 'utf8')),
            }))
            .filter((entry) => entry.sites.length > 0);
        expect(deletionSites).toEqual([]);

        const namedCallers = files
            .filter((file) => readFileSync(file, 'utf8').includes(REPO_OWNER_NAME_CALL))
            .map((file) => relative(E2E_ROOT, file).replace(/\\/g, '/'));
        expect(namedCallers).toEqual([]);
    });
});

describe('github-estate: generateFromTemplate carries the variant branches', () => {
    it('always sends include_all_branches: true', async () => {
        const stub = stubFetch();
        await estate.generateFromTemplate({
            repo: 'ever-works/app-fixture-hello',
            newName: 'apw-e2e-copy',
        });
        expect(bodyOf(stub).include_all_branches).toBe(true);
    });

    it('sends true even when the caller asks for false', async () => {
        const stub = stubFetch();
        await estate.generateFromTemplate({
            repo: 'ever-works/app-fixture-hello',
            newName: 'apw-e2e-copy',
            includeAllBranches: false,
        });
        expect(bodyOf(stub).include_all_branches).toBe(true);
    });

    it('posts to the generate route with the new name and the caller token', async () => {
        const stub = stubFetch();
        await estate.generateFromTemplate({
            repo: 'ever-works/app-fixture-hello',
            newName: 'apw-e2e-copy',
            token: 'customer-token',
            baseUrl: 'http://127.0.0.1:3900/',
        });
        expect(urlOf(stub)).toBe(
            'http://127.0.0.1:3900/repos/ever-works/app-fixture-hello/generate',
        );
        expect(stub.mock.calls[0]?.[1]?.method).toBe('POST');
        expect(bodyOf(stub).name).toBe('apw-e2e-copy');
        const headers = stub.mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(headers.authorization).toBe('Bearer customer-token');
    });
});

describe('github-estate: the fake is honoured only in fake mode', () => {
    it('uses APW_E2E_GITHUB_FAKE_URL when EVER_WORKS_E2E_FAKES=1', async () => {
        vi.stubEnv('EVER_WORKS_E2E_FAKES', '1');
        vi.stubEnv('APW_E2E_GITHUB_FAKE_URL', 'http://127.0.0.1:3900');
        const stub = stubFetch(200, { full_name: 'ever-works/app-fixture-hello' });
        await estate.getRepo({ repo: 'ever-works/app-fixture-hello' });
        expect(urlOf(stub)).toBe('http://127.0.0.1:3900/repos/ever-works/app-fixture-hello');
    });

    it('ignores APW_E2E_GITHUB_FAKE_URL without the switch', async () => {
        vi.stubEnv('EVER_WORKS_E2E_FAKES', '0');
        vi.stubEnv('APW_E2E_GITHUB_FAKE_URL', 'http://127.0.0.1:3900');
        const stub = stubFetch(200, { full_name: 'ever-works/app-fixture-hello' });
        await estate.getRepo({ repo: 'ever-works/app-fixture-hello' });
        expect(urlOf(stub)).toBe('https://api.github.com/repos/ever-works/app-fixture-hello');
    });
});

describe('github-estate: HTTP outcomes are returned, never thrown', () => {
    it('returns { status, body } for a 404 instead of throwing', async () => {
        stubFetch(404, { message: 'Not Found' });
        const result = await estate.getRepo({ repo: 'ever-works/missing', token: 'estate' });
        expect(result.status).toBe(404);
        expect(result.body).toEqual({ message: 'Not Found' });
    });

    it('requires an explicit token for pushCommit and never falls back to the estate', async () => {
        vi.stubEnv('APW_E2E_GITHUB_ESTATE_TOKEN', 'estate-token');
        const stub = stubFetch(201, { content: { sha: 'abc' } });
        const withoutToken: Omit<estate.PushCommitInput, 'token'> = {
            repo: 'ever-works/apw-e2e-copy',
            branch: 'variant/build-failure',
            files: { 'src/server.mjs': 'export {};\n' },
            message: 'variant',
        };
        await expect(estate.pushCommit(withoutToken as estate.PushCommitInput)).rejects.toThrow(
            /customer account's own token/,
        );
        expect(stub).not.toHaveBeenCalled();
    });
});

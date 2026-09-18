/**
 * Unit spec for the evidence builder, the lane summary and the canary-sink
 * reader (APW-13 T11, `tasks.md:163-174`).
 *
 * Four things this file proves:
 *
 *   1. **Evidence validates against the required set T61 publishes** — plan §3.1
 *      (`plan.md:143`) and `tasks.md:698-700` — and a file missing
 *      `license.class`, `passCount` or `upstream.kind` fails, read from a real
 *      file on disk, not from an in-memory object (ACC-13-23, `spec.md:572`).
 *   2. **The summary shows spend against budget** and marks an over-budget run
 *      with reason `budget` (spec §6.2, `spec.md:479-483`; ACC-13-16).
 *   3. **An attachment carrying a known secret fails the run** before it is
 *      uploaded or written (ACC-13-16, ACC-13-23) with reason
 *      `secret_in_artefact`.
 *   4. **A `truncated` sink page is followed and a wrong read token is
 *      refused** with its status (plan §5.3, `plan.md:353-357`) — the reader
 *      never returns `authorization`, and a `401`/`403` surfaces as a typed
 *      refusal carrying the status rather than a statusless throw.
 *
 * Every sink test drives a stub `fetch`, so no test touches the network, a
 * cluster or a GitHub repository.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import * as evidence from '../app-works-evidence';
import {
    CanaryLeakError,
    CanarySinkRefusal,
    SINK_EPOCH,
    assertNoLeak,
    listRequests,
} from '../canary-sink';

const HONEYTOKEN = 'apw-e2e-honeytoken-6f1c9d2e4b';
const RUN_ID = 'run-2026-09-17T10-00-00Z';

let workspace: string | undefined;

async function tempRoot(): Promise<string> {
    workspace ??= await mkdtemp(join(tmpdir(), 'apw13-evidence-'));
    return workspace;
}

afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** The plan §3.1 example, as the lane would assemble it. */
function buildInput(): evidence.BuildEvidenceInput {
    return {
        blueprint: { id: 'cal-diy', version: '0.1.0', sha: 'a'.repeat(40) },
        upstream: { repo: 'calcom/cal.diy', sha: 'b'.repeat(40), kind: 'pin' },
        license: { spdx: 'MIT', class: 'green' },
        platform: { environment: 'stage', version: '0.9.0' },
        lane: 'golden-path',
        passCount: 3,
        runId: RUN_ID,
        startedAt: '2026-09-17T10:00:00.000Z',
        finishedAt: '2026-09-17T10:55:00.000Z',
        steps: [
            { id: 'ACC-13-07', result: 'pass', seconds: 2710, observation: 'app.build.succeeded' },
        ],
        spend: { actionsMinutes: 47, tokens: 812345 },
        evidenceUrl: 'https://github.com/ever-works/app-fixture-hello/actions/runs/1',
    };
}

/** The same object with one top-level field taken away. */
function withoutTopLevel(field: string): Record<string, unknown> {
    const source = buildInput() as unknown as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) if (key !== field) copy[key] = value;
    return copy;
}

/** The same object with one field taken out of a nested object. */
function withoutNested(parent: string, field: string): Record<string, unknown> {
    const source = buildInput() as unknown as Record<string, unknown>;
    const nested: Record<string, unknown> = { ...(source[parent] as Record<string, unknown>) };
    const rebuilt: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(nested)) if (key !== field) rebuilt[key] = value;
    return { ...source, [parent]: rebuilt };
}

describe('app-works-evidence: the §3.1 evidence file', () => {
    it('requires exactly the field set T61 publishes', () => {
        expect([...evidence.EVIDENCE_REQUIRED_FIELDS]).toEqual([
            'blueprint',
            'upstream',
            'license',
            'platform',
            'lane',
            'passCount',
            'runId',
            'startedAt',
            'steps',
            'spend',
        ]);
        expect(evidence.EVIDENCE_SCHEMA_PATH).toBe(
            'ever-works/templates/schema/evidence.schema.json',
        );
    });

    it('accepts the built object and names the external schema', () => {
        const built = evidence.buildEvidence(buildInput());
        expect(built.schema).toBe(evidence.EVIDENCE_SCHEMA_PATH);
        expect(evidence.validateEvidence(built)).toEqual({ ok: true, errors: [] });
        expect(evidence.EVIDENCE_SCHEMA_URL).toContain('github.com/ever-works/templates');
    });

    it('fails an object missing passCount', () => {
        const result = evidence.validateEvidence(withoutTopLevel('passCount'));
        expect(result.ok).toBe(false);
        expect(result.errors).toContain('passCount: is required');
    });

    it('fails an object missing upstream.kind', () => {
        const result = evidence.validateEvidence(withoutNested('upstream', 'kind'));
        expect(result.ok).toBe(false);
        expect(result.errors).toContain('upstream.kind: is required');
    });

    it('fails an object missing license.class', () => {
        const result = evidence.validateEvidence(withoutNested('license', 'class'));
        expect(result.ok).toBe(false);
        expect(result.errors).toContain('license.class: is required');
    });

    it('rejects values outside the two enums and a passCount below one', () => {
        const wrong = {
            ...buildInput(),
            upstream: { repo: 'calcom/cal.diy', sha: 'b'.repeat(40), kind: 'fork' },
            license: { spdx: 'MIT', class: 'blue' },
            passCount: 0,
        };
        const result = evidence.validateEvidence(wrong);
        expect(result.ok).toBe(false);
        expect(result.errors.join('\n')).toMatch(/upstream\.kind: must be one of pin \| canary/);
        expect(result.errors.join('\n')).toMatch(
            /license\.class: must be one of green \| amber \| red \| unknown/,
        );
        expect(result.errors.join('\n')).toMatch(/passCount: must be an integer >= 1/);
    });

    it('buildEvidence refuses to assemble an invalid object', () => {
        const missingKind = withoutNested('upstream', 'kind');
        expect(() =>
            evidence.buildEvidence(missingKind as unknown as evidence.BuildEvidenceInput),
        ).toThrow(/upstream\.kind: is required/);
    });
});

describe('app-works-evidence: reading a file from disk (ACC-13-23)', () => {
    it('reads a valid file at evidence/<blueprint-id>/<runId>.json', async () => {
        const root = await tempRoot();
        const written = await evidence.writeEvidence(evidence.buildEvidence(buildInput()), {
            root,
            secrets: [],
        });
        expect(written.path).toBe(join(root, 'evidence', 'cal-diy', `${RUN_ID}.json`));
        expect(written.bytes).toBeGreaterThan(100);

        const stored = JSON.parse(await readFile(written.path, 'utf8')) as Record<string, unknown>;
        expect(stored.schema).toBe(evidence.EVIDENCE_SCHEMA_PATH);
        expect(stored.passCount).toBe(3);
        expect((stored.license as Record<string, unknown>).class).toBe('green');

        await expect(evidence.readEvidenceFile(written.path)).resolves.toMatchObject({ ok: true });
    });

    it('fails a file whose license.class, passCount or upstream.kind is missing', async () => {
        const root = await tempRoot();
        const cases: Array<[string, Record<string, unknown>, string]> = [
            ['license-class', withoutNested('license', 'class'), 'license.class: is required'],
            ['pass-count', withoutTopLevel('passCount'), 'passCount: is required'],
            ['upstream-kind', withoutNested('upstream', 'kind'), 'upstream.kind: is required'],
        ];
        for (const [name, value, expected] of cases) {
            const path = join(root, 'evidence', 'cal-diy', `${name}.json`);
            await writeFile(path, JSON.stringify(value, null, 4), 'utf8');
            const result = await evidence.readEvidenceFile(path);
            expect(result.ok, `${name} should fail`).toBe(false);
            expect(result.errors).toContain(expected);
        }
    });

    it('reports a file that is not JSON rather than throwing', async () => {
        const root = await tempRoot();
        const path = join(root, 'evidence', 'cal-diy', 'broken.json');
        await writeFile(path, 'not json', 'utf8');
        const result = await evidence.readEvidenceFile(path);
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/is not JSON/);
    });
});

describe('app-works-evidence: the lane summary shows spend against budget (§6.2)', () => {
    const rows: evidence.LaneSummaryRow[] = [
        {
            scenarioId: 'ACC-13-07',
            step: 'fork',
            result: 'pass',
            seconds: 2710,
            observation: 'app.build.succeeded',
            evidenceUrl: 'https://ci.example/run/1',
        },
        {
            scenarioId: 'ACC-13-11',
            step: 'canary',
            result: 'skipped: no canary fixture',
            observation: 'upstream.canary.absent',
        },
        {
            scenarioId: 'ACC-13-13',
            step: 'deploy',
            result: 'fail',
            observation: 'app.deploy.timeout',
        },
    ];

    it('renders the table, the spend line and what was left behind', () => {
        const summary = evidence.laneSummaryTable({
            rows,
            spend: { actionsMinutes: 47, tokens: 812345 },
            budget: { actionsMinutes: 60, tokens: 1000000 },
            leftBehind: [
                {
                    kind: 'namespace',
                    name: 'apw-e2e-abc',
                    expiresAt: '2026-09-18T10:00:00.000Z',
                },
                { kind: 'repository', name: 'ever-works/apw-e2e-abc' },
            ],
        });

        expect(summary).toContain(
            '| Scenario | Step | Result | Duration | First failing observation | Evidence |',
        );
        expect(summary).toContain(
            '| ACC-13-07 | fork | pass | 2710 s | app.build.succeeded | https://ci.example/run/1 |',
        );
        expect(summary).toContain('| ACC-13-11 | canary | skipped: no canary fixture | — |');
        expect(summary).toContain('| ACC-13-13 | deploy | fail | — | app.deploy.timeout |');
        expect(summary).toContain('**Spend: 47 / 60 Actions minutes · 812345 / 1000000 tokens**');
        expect(summary).toContain('**Left behind for investigation**');
        expect(summary).toContain('- `namespace` `apw-e2e-abc` — expires 2026-09-18T10:00:00.000Z');
        expect(summary).toContain('- `repository` `ever-works/apw-e2e-abc` — no expiry recorded');
        expect(summary).not.toContain('Run failed');
    });

    it('fails the run with reason budget when either dimension is over (ACC-13-16)', () => {
        const verdict = evidence.budgetExceeded(
            { actionsMinutes: 61, tokens: 812345 },
            { actionsMinutes: 60, tokens: 1000000 },
        );
        expect(verdict).toEqual({
            exceeded: true,
            reason: 'budget',
            over: { actionsMinutes: true, tokens: false },
        });

        const summary = evidence.laneSummaryTable({
            rows: [{ scenarioId: 'ACC-13-01', step: 'build', result: 'pass' }],
            spend: { actionsMinutes: 61, tokens: 812345 },
            budget: { actionsMinutes: 60, tokens: 1000000 },
        });
        expect(summary).toContain('**Spend: 61 / 60 Actions minutes · 812345 / 1000000 tokens**');
        expect(summary).toContain('**Run failed: reason `budget`** (over: actionsMinutes)');
        expect(summary).toContain('- nothing left behind');
    });

    it('refuses a result outside the §6.2 vocabulary', () => {
        expect(evidence.laneResultOf('not reached')).toEqual({ kind: 'not reached' });
        expect(evidence.laneResultOf('skipped: budget')).toEqual({
            kind: 'skipped',
            reason: 'budget',
        });
        expect(() =>
            evidence.laneSummaryTable({
                rows: [{ scenarioId: 'ACC-13-01', step: 'build', result: 'flaky' }],
                spend: { actionsMinutes: 1, tokens: 1 },
                budget: { actionsMinutes: 60, tokens: 1000 },
            }),
        ).toThrow(/is not a §6.2 result/);
    });
});

describe('app-works-evidence: no secret reaches an artefact (ACC-13-16, ACC-13-23)', () => {
    it('fails an attachment that carries a known secret', () => {
        const attachment = {
            name: 'run-log.txt',
            content: `POST /collect\nx-api-key: ${HONEYTOKEN}\n`,
        };
        expect(() =>
            evidence.prepareArtefactForUpload(attachment, [HONEYTOKEN, 'other-secret']),
        ).toThrow(/reason: secret_in_artefact/);
    });

    it('carries the reason token secret_in_artefact', () => {
        const caught = evidence.scanArtefact(`body=${HONEYTOKEN}`, [HONEYTOKEN]);
        expect(caught.ok).toBe(false);
        expect(caught.findings).toEqual([{ secret: HONEYTOKEN, at: 5 }]);

        let thrown: evidence.EvidenceError | undefined;
        try {
            evidence.assertArtefactClean(new TextEncoder().encode(HONEYTOKEN), [HONEYTOKEN]);
        } catch (error) {
            thrown = error as evidence.EvidenceError;
        }
        expect(thrown).toBeInstanceOf(evidence.EvidenceError);
        expect(thrown?.reason).toBe('secret_in_artefact');
    });

    it('passes a clean attachment through', () => {
        const prepared = evidence.prepareArtefactForUpload(
            { name: 'run-log.txt', content: 'POST /collect\nx-api-key: [redacted]\n' },
            [HONEYTOKEN],
        );
        expect(prepared.scan.ok).toBe(true);
        expect(prepared.attachment.name).toBe('run-log.txt');
    });

    it('refuses to write an evidence file that carries a known secret', async () => {
        const root = await tempRoot();
        const tainted = evidence.buildEvidence({
            ...buildInput(),
            runId: 'run-tainted',
            steps: [
                {
                    id: 'ACC-13-07',
                    result: 'fail',
                    observation: `canary recorded ${HONEYTOKEN}`,
                },
            ],
        });
        await expect(
            evidence.writeEvidence(tainted, { root, secrets: [HONEYTOKEN] }),
        ).rejects.toThrow(/reason: secret_in_artefact/);

        // The file must not exist: the scan happens before the write.
        await expect(
            readFile(join(root, 'evidence', 'cal-diy', 'run-tainted.json'), 'utf8'),
        ).rejects.toThrow(/ENOENT/);
    });

    it('scans the APW_E2E_* credential-shaped variables by default', () => {
        vi.stubEnv('APW_E2E_GITHUB_ESTATE_TOKEN', 'ghp_estate_value_123');
        vi.stubEnv('APW_E2E_RUN_ID', 'run-2026-09-17T10-00-00Z');
        vi.stubEnv('APW_E2E_LANE', 'golden-path');
        const values = evidence.environmentSecretValues();
        expect(values).toContain('ghp_estate_value_123');
        // Lane inputs the evidence file carries by design are not secrets.
        expect(values).not.toContain('run-2026-09-17T10-00-00Z');
        expect(values).not.toContain('golden-path');
        vi.unstubAllEnvs();
    });
});

type SinkPage = { status?: number; body?: unknown; text?: string };

/** A `fetch` stub that answers the sink's read API page by page. */
function stubSink(pages: SinkPage[]) {
    let served = 0;
    const stub = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
            const page: SinkPage = pages[Math.min(served, pages.length - 1)] ?? {};
            served += 1;
            return new Response(page.text ?? JSON.stringify(page.body ?? {}), {
                status: page.status ?? 200,
            });
        },
    );
    return stub;
}

const FIRST_ROW = {
    method: 'POST',
    path: '/collect?env=AAAA',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sink-side-leak' },
    body: '{"greeting":"hello"}',
    receivedAt: '2026-09-17T10:00:00.000Z',
    remoteAddress: '203.0.113.7',
};

const SECOND_ROW = {
    method: 'POST',
    path: '/install',
    headers: { 'content-type': 'application/json' },
    body: 'npm_config_registry=https://registry.npmjs.org',
    receivedAt: '2026-09-17T10:00:05.000Z',
    remoteAddress: '203.0.113.7',
};

const SINK_OPTIONS = { baseUrl: 'https://canary.invalid', token: 'read-token' };

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('canary-sink: paging, refusal and the leak search (plan §5.3)', () => {
    it('follows a truncated page forward by receivedAt', async () => {
        const stub = stubSink([
            { body: { requests: [FIRST_ROW], truncated: true } },
            { body: { requests: [SECOND_ROW], truncated: false } },
        ]);
        const requests = await listRequests(SINK_EPOCH, { ...SINK_OPTIONS, fetchImpl: stub });

        expect(stub).toHaveBeenCalledTimes(2);
        expect(String(stub.mock.calls[0]?.[0])).toBe(
            `https://canary.invalid/requests?since=${encodeURIComponent(SINK_EPOCH)}&limit=200`,
        );
        expect(String(stub.mock.calls[1]?.[0])).toBe(
            `https://canary.invalid/requests?since=${encodeURIComponent(
                FIRST_ROW.receivedAt,
            )}&limit=200`,
        );
        expect(requests.map((request) => request.receivedAt)).toEqual([
            FIRST_ROW.receivedAt,
            SECOND_ROW.receivedAt,
        ]);
    });

    it('never returns an authorization header', async () => {
        const stub = stubSink([{ body: { requests: [FIRST_ROW], truncated: false } }]);
        const requests = await listRequests(SINK_EPOCH, { ...SINK_OPTIONS, fetchImpl: stub });
        expect(requests[0]?.headers.authorization).toBeUndefined();
        expect(JSON.stringify(requests)).not.toContain('sink-side-leak');
        expect(requests[0]?.headers['content-type']).toBe('application/json');
    });

    it('surfaces a wrong read token as a refusal carrying 401 or 403', async () => {
        for (const status of [401, 403]) {
            const stub = stubSink([{ status, text: '{"error":"bad token"}' }]);
            const caught = await listRequests(SINK_EPOCH, {
                ...SINK_OPTIONS,
                fetchImpl: stub,
            }).catch((error: unknown) => error);
            expect(caught).toBeInstanceOf(CanarySinkRefusal);
            expect((caught as CanarySinkRefusal).status).toBe(status);
            expect((caught as CanarySinkRefusal).body).toContain('bad token');
            expect((caught as CanarySinkRefusal).message).toMatch(
                new RegExp(`refused this token \\(HTTP ${status}\\)`),
            );
        }
    });

    it('fails when a recorded body or header carries a known value', async () => {
        const leaky = {
            ...SECOND_ROW,
            headers: { 'x-install-env': HONEYTOKEN },
            body: `env=${HONEYTOKEN}`,
        };
        const stub = stubSink([{ body: { requests: [FIRST_ROW, leaky], truncated: false } }]);
        const caught = await assertNoLeak([HONEYTOKEN, 'not-present'], {
            ...SINK_OPTIONS,
            since: SINK_EPOCH,
            fetchImpl: stub,
        }).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(CanaryLeakError);
        expect((caught as CanaryLeakError).values).toEqual([HONEYTOKEN]);
        expect((caught as CanaryLeakError).message).toMatch(/1 known secret value\(s\)/);
    });

    it('passes a clean recording and reports what it scanned', async () => {
        const stub = stubSink([
            { body: { requests: [FIRST_ROW, SECOND_ROW], truncated: true } },
            { body: { requests: [], truncated: false } },
        ]);
        const report = await assertNoLeak([HONEYTOKEN], {
            ...SINK_OPTIONS,
            since: SINK_EPOCH,
            fetchImpl: stub,
        });
        expect(report).toEqual({ values: [HONEYTOKEN], scanned: 2, pages: 2 });
    });

    it('searches a supplied recording without reading the sink', async () => {
        const stub = stubSink([{ status: 500, text: 'should not be read' }]);
        const report = await assertNoLeak([HONEYTOKEN], {
            ...SINK_OPTIONS,
            requests: [
                {
                    method: 'POST',
                    path: '/collect',
                    headers: {},
                    body: `env=${HONEYTOKEN}`,
                    receivedAt: FIRST_ROW.receivedAt,
                },
            ],
            fetchImpl: stub,
        }).catch((error: unknown) => error);
        expect(report).toBeInstanceOf(CanaryLeakError);
        expect(stub).not.toHaveBeenCalled();
    });
});

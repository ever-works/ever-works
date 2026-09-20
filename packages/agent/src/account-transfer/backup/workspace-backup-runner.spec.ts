import { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { DataSource } from 'typeorm';
import { BACKUP_DOMAINS } from '@ever-works/contracts';
import { referencedEntities } from './collectors/domain-specs';
import type { WorkspaceBackupRepository } from '../../database/repositories/workspace-backup.repository';
import type { BackupStorage } from './backup-storage';
import {
    EMPTY_BACKUP_WORK_CONTENT,
    type BackupWorkContent,
    type BackupWorkContentSource,
} from './backup-work-content';
import { WorkspaceBackupRunner, type WorkspaceBackupRunOptions } from './workspace-backup-runner';

/**
 * The runner's job is not "produce a zip" — the writer does that. Its job is
 * everything that has to stay true when something goes wrong: all fifteen
 * domains are walked whatever any one of them does, a failing domain costs
 * only itself, a cancelled backup leaves nothing behind, and a storage
 * failure is recorded as a reason the card has copy for rather than as a
 * generic error.
 */

const OPTIONS: WorkspaceBackupRunOptions = {
    workspace: { id: 'org-1', slug: 'acme', displayName: 'Acme', kind: 'organization' },
    account: { id: 'u1', displayName: 'Owner', email: 'owner@example.invalid' },
    build: 'test-build',
};

function backupRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'b1',
        userId: 'u1',
        organizationId: 'org-1',
        tenantId: 't1',
        status: 'queued',
        includeFullHistory: false,
        ...overrides,
    };
}

interface Harness {
    runner: WorkspaceBackupRunner;
    repository: {
        claimForRun: jest.Mock;
        heartbeat: jest.Mock;
        markTerminal: jest.Mock;
    };
    storage: jest.Mocked<BackupStorage>;
    dataSource: DataSource;
    terminal: () => Record<string, unknown> | undefined;
}

function harness(
    options: {
        rows?: Record<string, Record<string, unknown>[]>;
        putArchive?: BackupStorage['putArchive'];
        supportsStreaming?: boolean;
        cancelAfterDomains?: number;
        storage?: BackupStorage | undefined;
        workContent?: BackupWorkContentSource;
        /** Entity whose page query throws, to exercise a domain that fails mid-walk. */
        failPageFor?: string;
        /** Make the final compare-and-set miss, as a cancel during the copy phase does. */
        settleReturns?: boolean;
        /** The status the row is left at when the final settle misses. */
        settledElsewhereAs?: string;
        /** Fields of the backup row other than its status, e.g. a personal workspace's null organization. */
        row?: Record<string, unknown>;
    } = {},
): Harness {
    const rows = options.rows ?? {};
    // One mutable status, shared by the fake row and every transition, so the
    // runner's own cancellation probe sees what a real database would.
    const state = { status: 'queued' };
    let heartbeats = 0;

    const terminalCalls: Array<Record<string, unknown>> = [];
    const repository = {
        claimForRun: jest.fn().mockImplementation(async () => {
            if (state.status !== 'queued') return false;
            state.status = 'running';
            return true;
        }),
        heartbeat: jest.fn().mockImplementation(async () => {
            heartbeats += 1;
            if (
                options.cancelAfterDomains !== undefined &&
                heartbeats > options.cancelAfterDomains
            ) {
                state.status = 'cancelled';
            }
            return state.status === 'running';
        }),
        markTerminal: jest
            .fn()
            .mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
                terminalCalls.push(patch);
                if (options.settleReturns === false) {
                    // The real compare-and-set is bounded by the row's
                    // current status, so a row settled elsewhere is not
                    // updated and the status stays where the other writer
                    // left it.
                    state.status = options.settledElsewhereAs ?? 'cancelled';
                    return false;
                }
                state.status = String(patch.status);
                return true;
            }),
    };

    const dataSource = {
        hasMetadata: (entity: string) => entity in rows,
        getMetadata: (entity: string) => ({
            target: entity,
            columns: Object.keys(rows[entity]?.[0] ?? { id: '' }).map((propertyName) => ({
                propertyName,
            })),
            // The row source reads the real primary key for its ORDER BY
            // tiebreaker rather than assuming `id`, so the fake has to carry
            // one — a metadata double without `primaryColumns` is not a
            // metadata double.
            primaryColumns: [{ propertyName: 'id' }],
        }),
        getRepository: (entity: string) => ({
            findOne: async () =>
                entity === 'WorkspaceBackup'
                    ? backupRow({ ...options.row, status: state.status })
                    : entity === 'User'
                      ? { id: 'u1', name: 'Owner', email: 'owner@example.invalid' }
                      : null,
        }),
        createQueryBuilder: () => {
            // A fixture with no `rows` entry for an entity never reaches
            // here — `hasMetadata` already said the build does not know it —
            // so a builder is only ever asked for when the test supplied
            // rows for that table.
            let target = '';
            const builder: Record<string, unknown> = {
                select: () => builder,
                from: (entity: unknown) => {
                    target = String(entity);
                    return builder;
                },
                andWhere: () => builder,
                orderBy: () => builder,
                addOrderBy: () => builder,
                skip: () => builder,
                take: () => builder,
                getCount: async () => (rows[target] ?? []).length,
                getRawMany: async () =>
                    target === options.failPageFor
                        ? Promise.reject(new Error(`page query for ${target} failed`))
                        : (rows[target] ?? []).map((row) =>
                              Object.fromEntries(
                                  Object.entries(row).map(([key, value]) => [
                                      `entity_${key}`,
                                      value,
                                  ]),
                              ),
                          ),
            };
            return builder;
        },
    } as unknown as DataSource;

    const storage =
        options.storage === undefined
            ? ({
                  warmUp: jest.fn().mockResolvedValue(undefined),
                  supportsStreaming: jest.fn().mockReturnValue(options.supportsStreaming ?? true),
                  backendName: jest.fn().mockReturnValue('fixture-backend'),
                  putArchive:
                      options.putArchive ??
                      (jest.fn().mockImplementation(async (source: Readable) => {
                          for await (const chunk of source) void chunk;
                          return { key: 'u1/archive.zip', backend: 'fixture-backend' };
                      }) as unknown as BackupStorage['putArchive']),
                  getArchiveStream: jest.fn(),
                  readObject: jest.fn().mockResolvedValue({
                      stream: Readable.from([Buffer.from('bytes')]),
                      mimeType: 'application/pdf',
                      size: 5,
                  }),
                  deleteArchive: jest.fn().mockResolvedValue(undefined),
              } as unknown as jest.Mocked<BackupStorage>)
            : (options.storage as jest.Mocked<BackupStorage>);

    const runner = new WorkspaceBackupRunner(
        repository as unknown as WorkspaceBackupRepository,
        dataSource,
        storage,
        options.workContent,
    );

    return {
        runner,
        repository,
        storage,
        dataSource,
        terminal: () => terminalCalls[terminalCalls.length - 1],
    };
}

describe('WorkspaceBackupRunner', () => {
    it('walks every one of the fifteen domains and records them all', async () => {
        const h = harness();
        const result = await h.runner.run('b1', OPTIONS);

        expect(result.status).toBe('ready');
        const summary = h.terminal()?.manifestSummary as { domains: { key: string }[] };
        expect(summary.domains).toHaveLength(15);
        expect(summary.domains.map((domain) => domain.key)).toEqual(
            BACKUP_DOMAINS.map((domain) => domain.key),
        );
    });

    it('reports every domain as empty — not as missing — for a workspace with nothing in it', async () => {
        // Spec S-17: a brand-new workspace still gets a backup, and the
        // manifest says "you have none of these" rather than staying silent.
        const h = harness();
        await h.runner.run('b1', OPTIONS);

        const summary = h.terminal()?.manifestSummary as { domains: { status: string }[] };
        expect(summary.domains.every((domain) => domain.status === 'empty')).toBe(true);
        expect(h.terminal()?.status).toBe('ready');
    });

    it('settles the row with the archive’s size, digest and expiry', async () => {
        const h = harness();
        await h.runner.run('b1', OPTIONS);

        const patch = h.terminal()!;
        expect(patch.status).toBe('ready');
        expect(patch.storageKey).toBe('u1/archive.zip');
        expect(patch.storageBackend).toBe('fixture-backend');
        expect(patch.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Number(patch.sizeBytes)).toBeGreaterThan(0);
        expect(patch.expiresAt).toBeInstanceOf(Date);
        expect(patch.progressPercent).toBe(100);
    });

    it('heartbeats as it goes, so a dead worker is noticed rather than hanging at running', async () => {
        const h = harness();
        await h.runner.run('b1', OPTIONS);

        // One per domain, at minimum.
        expect(h.repository.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(15);
        const domains = h.repository.heartbeat.mock.calls
            .map((call) => (call[1] as { currentDomain?: string }).currentDomain)
            .filter(Boolean);
        expect(domains).toContain('knowledge');
        expect(domains).toContain('activity');
    });

    it('does nothing for a backup that is not there any more', async () => {
        const h = harness();
        (h.dataSource as unknown as { getRepository: () => unknown }).getRepository = () => ({
            findOne: async () => null,
        });

        expect(await h.runner.run('b1', OPTIONS)).toEqual({
            status: 'skipped',
            reason: 'backup-not-found',
            backupId: 'b1',
        });
    });

    it('does nothing for a backup another worker already claimed', async () => {
        const h = harness();
        h.repository.claimForRun.mockResolvedValue(false);

        expect(await h.runner.run('b1', OPTIONS)).toEqual({
            status: 'skipped',
            reason: 'already-claimed',
            backupId: 'b1',
        });
    });

    it('fails with storage_unavailable when the backend will not take the archive', async () => {
        const h = harness({
            putArchive: jest.fn().mockImplementation(async (source: Readable) => {
                for await (const _chunk of source) void _chunk;
                throw new Error('bucket unreachable');
            }) as unknown as BackupStorage['putArchive'],
        });

        const result = await h.runner.run('b1', OPTIONS);
        expect(result).toEqual({ status: 'failed', reason: 'storage_unavailable', backupId: 'b1' });
        // The reason the card has specific copy for — never a generic error.
        expect(h.terminal()?.failureReason).toBe('storage_unavailable');
    });

    it('fails with internal, not silently, when no storage backend is configured', async () => {
        const h = harness({ storage: undefined as unknown as BackupStorage });
        const runner = new WorkspaceBackupRunner(
            h.repository as unknown as WorkspaceBackupRepository,
            h.dataSource,
            undefined,
        );

        const result = await runner.run('b1', OPTIONS);
        expect(result.reason).toBe('internal');
        expect(h.repository.markTerminal).toHaveBeenCalled();
        expect(h.terminal()?.failureReason).toBe('internal');
    });

    it('stops when the owner cancels, and settles as cancelled rather than ready', async () => {
        const h = harness({ cancelAfterDomains: 2 });
        const result = await h.runner.run('b1', OPTIONS);

        expect(result.status).toBe('cancelled');
        // Nothing was marked ready, so no archive is offered for download.
        expect(h.repository.markTerminal).not.toHaveBeenCalled();
        // And fewer than fifteen domains were walked.
        expect(h.repository.heartbeat.mock.calls.length).toBeLessThan(15);
    });

    describe('a domain that depends on another domain’s ids', () => {
        // `knowledge` reaches five of its seven files through `workIds`,
        // which the `works` domain registers. Registration used to happen
        // AFTER the paging loop, so a Work page query that spent its retries
        // left the name unregistered entirely — and an unregistered name is
        // indistinguishable from "this workspace has no Works". The five
        // knowledge files were then written with zero records and NO error,
        // and the coverage table reported the section `empty`: "you have
        // none of these" for a knowledge base that was simply never read.
        const ROWS: Record<string, Record<string, unknown>[]> = {
            ...Object.fromEntries(
                referencedEntities().map((entity) => [entity, [] as Record<string, unknown>[]]),
            ),
            Work: [{ id: 'w1', slug: 'acme-tools', userId: 'u1', organizationId: 'org-1' }],
            WorkKnowledgeDocument: [
                { id: 'd1', workId: 'w1', title: 'A document', createdAt: '2026-01-01' },
            ],
        };

        function domain(terminal: Record<string, unknown> | undefined, key: string) {
            const summary = terminal?.manifestSummary as {
                domains: { key: string; status: string; records: number; error?: unknown }[];
            };
            return summary.domains.find((entry) => entry.key === key)!;
        }

        it('never reports a dependent domain as empty when its parent did not finish', async () => {
            const h = harness({ rows: ROWS, failPageFor: 'Work' });
            await h.runner.run('b1', OPTIONS);

            // The `works` domain says so for itself, as it always did.
            expect(domain(h.terminal(), 'works').status).toBe('failed');
            // And the domain that depended on it no longer claims emptiness
            // over data it never read.
            const knowledge = domain(h.terminal(), 'knowledge');
            expect(knowledge.status).not.toBe('empty');
            expect(knowledge.status).not.toBe('complete');
        });

        it('names the shortfall so a reader can tell it from an absence', async () => {
            const h = harness({ rows: ROWS, failPageFor: 'Work' });
            await h.runner.run('b1', OPTIONS);

            expect(domain(h.terminal(), 'knowledge').error).toEqual(
                expect.objectContaining({ code: 'parent_ids_incomplete' }),
            );
        });

        it('still reports a dependent domain normally when the parent finished', async () => {
            const h = harness({ rows: ROWS });
            await h.runner.run('b1', OPTIONS);

            const knowledge = domain(h.terminal(), 'knowledge');
            expect(knowledge.error).toBeUndefined();
            expect(knowledge.records).toBeGreaterThan(0);
        });
    });

    describe('startFromPayload — start the archive, do not wait for it', () => {
        // The archive task reaches this over an RPC channel with a 45 s
        // per-request deadline. `runFromPayload` holds that request open for
        // the whole archive, so any real backup failed the task and lost its
        // notification. This returns once the claim is decided and leaves
        // the archive running — tracked, and settled on every failure.
        const PAYLOAD = { backupId: 'b1', userId: 'u1', organizationId: 'org-1' };

        function inFlight(runner: WorkspaceBackupRunner) {
            return (runner as unknown as { inFlight: Map<string, Promise<{ status: string }>> })
                .inFlight;
        }

        it('returns started while the archive is still being produced, then settles it', async () => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const h = harness({
                putArchive: jest.fn().mockImplementation(async (source: Readable) => {
                    await gate;
                    for await (const chunk of source) void chunk;
                    return { key: 'u1/archive.zip', backend: 'fixture-backend' };
                }) as unknown as BackupStorage['putArchive'],
            });

            const started = await h.runner.startFromPayload(PAYLOAD);

            expect(started).toEqual({ status: 'started', backupId: 'b1' });
            expect(h.repository.claimForRun).toHaveBeenCalledTimes(1);
            // Nothing is settled yet: the upload has not even been allowed to read.
            expect(h.repository.markTerminal).not.toHaveBeenCalled();
            expect(inFlight(h.runner).has('b1')).toBe(true);

            release();
            const outcome = await inFlight(h.runner).get('b1');

            expect(outcome?.status).toBe('ready');
            expect(h.terminal()?.status).toBe('ready');
            expect(inFlight(h.runner).has('b1')).toBe(false);
        });

        it('settles the row failed when the archive throws, even if the first settle throws too', async () => {
            const h = harness();
            (h.storage.warmUp as jest.Mock).mockRejectedValue(new Error('bucket gone'));
            h.repository.markTerminal.mockRejectedValueOnce(new Error('database went away'));

            const started = await h.runner.startFromPayload(PAYLOAD);
            expect(started.status).toBe('started');
            const outcome = await inFlight(h.runner).get('b1');

            expect(outcome).toEqual({ status: 'failed', reason: 'internal', backupId: 'b1' });
            // The failed attempt, then the one that landed.
            expect(h.repository.markTerminal).toHaveBeenCalledTimes(2);
            expect(h.terminal()).toEqual(expect.objectContaining({ status: 'failed' }));
            expect(inFlight(h.runner).has('b1')).toBe(false);
        });

        it('hands back a skip decided before any work started, and tracks nothing', async () => {
            const h = harness();
            h.repository.claimForRun.mockResolvedValue(false);

            await expect(h.runner.startFromPayload(PAYLOAD)).resolves.toEqual({
                status: 'skipped',
                reason: 'already-claimed',
                backupId: 'b1',
            });
            expect(inFlight(h.runner).size).toBe(0);
        });

        it('fails at once, like run, when no storage backend is configured', async () => {
            const h = harness();
            const runner = new WorkspaceBackupRunner(
                h.repository as unknown as WorkspaceBackupRepository,
                h.dataSource,
                undefined,
            );

            await expect(runner.startFromPayload(PAYLOAD)).resolves.toEqual({
                status: 'failed',
                reason: 'internal',
                backupId: 'b1',
            });
            expect(h.terminal()?.failureReason).toBe('internal');
        });
    });

    describe('a child file whose parent is in the SAME domain', () => {
        // `runDomain` planned a whole domain before reading any of its files,
        // and a `parent` file resolves its id list at plan time — so a child
        // whose parent sits earlier in the same domain always got `[]`, wrote
        // zero records, and (the name being unregistered at that moment) was
        // never flagged either. The cross-domain case (works → knowledge)
        // worked; every same-domain one did not.
        const ROWS: Record<string, Record<string, unknown>[]> = {
            ...Object.fromEntries(
                referencedEntities().map((entity) => [entity, [] as Record<string, unknown>[]]),
            ),
            Agent: [{ id: 'a1', userId: 'u1', organizationId: 'org-1' }],
            AgentMembership: [{ id: 'm1', agentId: 'a1' }],
            AgentBudget: [{ id: 'ab1', agentId: 'a1' }],
            Task: [{ id: 't1', userId: 'u1', organizationId: 'org-1' }],
            TaskAssignee: [{ id: 'ta1', taskId: 't1' }],
            Work: [{ id: 'w1', slug: 'acme-tools', userId: 'u1', organizationId: 'org-1' }],
            WorkDeployment: [{ id: 'wd1', workId: 'w1' }],
            AgentRun: [{ id: 'r1', userId: 'u1', organizationId: 'org-1' }],
            AgentRunLog: [{ id: 'rl1', runId: 'r1' }],
        };

        function domainOf(terminal: Record<string, unknown> | undefined, key: string) {
            const summary = terminal?.manifestSummary as {
                domains: {
                    key: string;
                    status: string;
                    error?: unknown;
                    files: { name: string; records: number }[];
                }[];
            };
            return summary.domains.find((entry) => entry.key === key)!;
        }

        it.each([
            ['agents', 'data/agents/memberships.jsonl'],
            ['agents', 'data/agents/budgets.jsonl'],
            ['tasks', 'data/tasks/assignees.jsonl'],
            ['works', 'data/works/deployments.jsonl'],
            ['runs', 'data/runs/run-logs.jsonl'],
        ])('writes the %s child rows into %s', async (key, name) => {
            const h = harness({ rows: ROWS });
            await h.runner.run('b1', OPTIONS);

            const file = domainOf(h.terminal(), key).files.find((entry) => entry.name === name);
            expect(file?.records).toBe(1);
        });

        it('reports the domain complete once its children are actually read', async () => {
            const h = harness({ rows: ROWS });
            await h.runner.run('b1', OPTIONS);

            const agents = domainOf(h.terminal(), 'agents');
            expect(agents.status).toBe('complete');
            expect(agents.error).toBeUndefined();
            // Three rows across three files: the agent, its membership and its budget.
            expect(agents.files.reduce((sum, entry) => sum + entry.records, 0)).toBe(3);
        });
    });

    describe('a personal workspace’s own organization-less rows', () => {
        // A person with no organization yet — the default state — owns
        // webhook subscriptions, code-host installations, onboarding
        // requests and email conversations whose `organizationId` is NULL.
        // The cross-account fix planned those four files as matching
        // nothing, so the owner's archive carried none of them and the
        // domains still reported `complete` or `empty`.
        const PERSONAL_OPTIONS: WorkspaceBackupRunOptions = {
            ...OPTIONS,
            workspace: { id: 'u1', slug: 'owner', displayName: 'Owner', kind: 'personal' },
        };
        const ROWS: Record<string, Record<string, unknown>[]> = {
            ...Object.fromEntries(
                referencedEntities().map((entity) => [entity, [] as Record<string, unknown>[]]),
            ),
            Agent: [{ id: 'a1', userId: 'u1', organizationId: null }],
            WebhookSubscription: [{ id: 'wh1', accountId: 'u1', organizationId: null }],
            WebhookDelivery: [{ id: 'wd1', subscriptionId: 'wh1' }],
            GitHubAppInstallation: [{ id: 'gh1', createdByUserId: 'u1', organizationId: null }],
            OnboardingRequest: [{ id: 'on1', accountId: 'u1', organizationId: null }],
            EmailConversation: [{ id: 'ec1', agentId: 'a1', organizationId: null }],
        };

        function file(terminal: Record<string, unknown> | undefined, name: string) {
            const summary = terminal?.manifestSummary as {
                domains: { key: string; files: { name: string; records: number }[] }[];
            };
            return summary.domains
                .flatMap((domain) => domain.files)
                .find((entry) => entry.name === name);
        }

        it.each([
            'data/connections/webhook-subscriptions.jsonl',
            'data/connections/code-host-installations.jsonl',
            'data/account/onboarding.jsonl',
            'data/communication/email-conversations.jsonl',
        ])('writes the owner’s rows into %s', async (name) => {
            const h = harness({ rows: ROWS, row: { organizationId: null } });
            await h.runner.run('b1', PERSONAL_OPTIONS);

            expect(file(h.terminal(), name)?.records).toBe(1);
        });

        it('writes the deliveries of the owner’s own subscriptions too', async () => {
            // Deliveries hang off `webhookIds`, which the subscriptions file
            // in the same domain registers. Both halves of the defect had to
            // go for this to hold: the parent had to be read at all, and the
            // child had to be planned after it.
            const h = harness({ rows: ROWS, row: { organizationId: null } });
            await h.runner.run('b1', PERSONAL_OPTIONS);

            expect(file(h.terminal(), 'data/connections/webhook-deliveries.jsonl')?.records).toBe(
                1,
            );
        });
    });

    describe('the copy and settle phase, which used to be silent', () => {
        // Two attachment rows, so `copyFiles` has work to do.
        const ROWS: Record<string, Record<string, unknown>[]> = {
            ...Object.fromEntries(
                referencedEntities().map((entity) => [entity, [] as Record<string, unknown>[]]),
            ),
            UserUpload: [
                {
                    id: 'up1',
                    userId: 'u1',
                    organizationId: 'org-1',
                    storagePath: 'u1/a.pdf',
                    originalFilename: 'a.pdf',
                    fileSize: 5,
                },
                {
                    id: 'up2',
                    userId: 'u1',
                    organizationId: 'org-1',
                    storagePath: 'u1/b.pdf',
                    originalFilename: 'b.pdf',
                    fileSize: 5,
                },
            ],
        };

        it('heartbeats while copying attachment bytes and before the final flush', async () => {
            // The whole copy phase reported nothing. With a 2 GiB attachment
            // budget over a remote object store it can run far past the
            // ten-minute stall window, so the sweeper failed backups that
            // were working — and the archive they then produced became an
            // orphan nothing could reach or delete.
            //
            // The heartbeat throttles itself to 25 s, which no unit test can
            // wait out, so the clock is advanced past the interval on every
            // read. What is asserted is the number of PROGRESS-less
            // heartbeats — the shape only the copy and finalise phases emit;
            // the per-domain ones all carry a `currentDomain`.
            let clock = Date.now();
            const now = jest.spyOn(Date, 'now').mockImplementation(() => {
                clock += 26_000;
                return clock;
            });
            try {
                const h = harness({ rows: ROWS });
                await h.runner.run('b1', OPTIONS);

                const bare = h.repository.heartbeat.mock.calls.filter(
                    (call) => Object.keys(call[1] as object).length === 0,
                );
                // Two attachments plus the report before `close()`/upload.
                expect(bare.length).toBeGreaterThanOrEqual(3);
            } finally {
                now.mockRestore();
            }
        });

        it('deletes the archive it produced when the row was settled elsewhere', async () => {
            // The compare-and-set is bounded to `running`, so a cancel during
            // the copy phase leaves it matching zero rows — and `storageKey`
            // never recorded. Expiry only visits ready rows, "delete now"
            // needs a key, and the prune pass removes the record BECAUSE the
            // key is null: a permanent, billable object nothing references.
            const h = harness({
                rows: ROWS,
                settleReturns: false,
                settledElsewhereAs: 'cancelled',
            });
            const result = await h.runner.run('b1', OPTIONS);

            expect(h.storage.deleteArchive).toHaveBeenCalledWith('u1/archive.zip');
            expect(result.status).toBe('cancelled');
        });

        it('reports the outcome that won, not the one it was about to write', async () => {
            const h = harness({ rows: ROWS, settleReturns: false, settledElsewhereAs: 'failed' });
            const result = await h.runner.run('b1', OPTIONS);

            expect(result.status).toBe('failed');
            expect(result.reason).toBe('failed');
        });
    });

    it('stops between pages, not only between domains, once the row leaves running', async () => {
        // `shouldStop()` was dead code: `cancelled.value` was written at
        // exactly one place, a domain boundary, immediately before the
        // runner returned — so no collector was ever suspended when it
        // flipped. The heartbeat's return value is the live signal: its
        // UPDATE is bounded to `status = 'running'`, so `false` is exactly
        // "this backup is no longer running".
        const h = harness({ cancelAfterDomains: 2 });
        const result = await h.runner.run('b1', OPTIONS);

        expect(result.status).toBe('cancelled');
        // The context's own stop signal is what a collector consults between
        // pages; it has to be reachable from the heartbeat, not only from
        // the domain-boundary probe.
        expect(h.repository.heartbeat).toHaveBeenCalled();
    });

    describe('Work content, read out of each Work’s own data repo', () => {
        // The existing JSON account export already carries each Work's items,
        // categories, tags, collections and comparisons. An archive that
        // claimed to be complete while carrying only the Work ROWS would
        // export LESS than the surface it sits beside, so these pin that the
        // content ships, that it comes from the injected port (the account
        // export's own walk) rather than from a second reader here, and that
        // a Work whose repo will not read costs its content and nothing more.
        // Every table any domain reads, empty, plus two Works. A fixture that
        // named only `Work` would leave the Works domain's other files "not
        // in this build" and report the domain `partial` for a reason that
        // has nothing to do with content — which would make the
        // partial-on-content assertion below prove nothing.
        const WORK_ROWS: Record<string, Record<string, unknown>[]> = {
            ...Object.fromEntries(
                referencedEntities().map((entity) => [entity, [] as Record<string, unknown>[]]),
            ),
            Work: [
                { id: 'w1', slug: 'acme-tools', userId: 'u1', organizationId: 'org-1' },
                { id: 'w2', slug: 'acme-apps', userId: 'u1', organizationId: 'org-1' },
            ],
        };

        function contentSource(
            impl: (id: string) => Promise<BackupWorkContent>,
        ): BackupWorkContentSource & { calls: string[] } {
            const calls: string[] = [];
            return {
                calls,
                readWorkContent: async (work) => {
                    calls.push(work.slug);
                    return impl(work.id);
                },
            };
        }

        function worksDomain(terminal: Record<string, unknown> | undefined) {
            const summary = terminal?.manifestSummary as {
                domains: {
                    key: string;
                    status: string;
                    records: number;
                    files: { name: string; records: number }[];
                }[];
            };
            return summary.domains.find((domain) => domain.key === 'works')!;
        }

        it('writes each Work’s content under data/works/content/<slug>/', async () => {
            const source = contentSource(async (id) => ({
                items: id === 'w1' ? [{ slug: 'a' }, { slug: 'b' }] : [{ slug: 'c' }],
                categories: [{ slug: 'cat' }],
                tags: [],
                collections: [],
                comparisons: [],
                siteConfig: { title: 'Acme' },
            }));

            const h = harness({ rows: WORK_ROWS, workContent: source });
            const result = await h.runner.run('b1', OPTIONS);

            expect(result.status).toBe('ready');
            // Both Works were visited, by slug, through the port.
            expect(source.calls).toEqual(['acme-tools', 'acme-apps']);

            const names = worksDomain(h.terminal()).files.map((file) => file.name);
            for (const slug of ['acme-tools', 'acme-apps']) {
                for (const group of ['items', 'categories', 'tags', 'collections', 'comparisons']) {
                    expect(names).toContain(`data/works/content/${slug}/${group}.jsonl`);
                }
                expect(names).toContain(`data/works/content/${slug}/site-config.json`);
            }
            // The optional singleton that was not supplied is not invented.
            expect(names).not.toContain('data/works/content/acme-tools/markdown-template.json');
        });

        it('counts the content rows into the Works domain rather than losing them', async () => {
            const source = contentSource(async (id) => ({
                ...EMPTY_BACKUP_WORK_CONTENT,
                items: id === 'w1' ? [{ slug: 'a' }, { slug: 'b' }] : [{ slug: 'c' }],
            }));

            const h = harness({ rows: WORK_ROWS, workContent: source });
            await h.runner.run('b1', OPTIONS);

            const works = worksDomain(h.terminal());
            const itemRecords = works.files
                .filter((file) => file.name.endsWith('/items.jsonl'))
                .reduce((sum, file) => sum + file.records, 0);
            expect(itemRecords).toBe(3);
            // The two Work rows plus the three items.
            expect(works.records).toBeGreaterThanOrEqual(5);
        });

        it('marks the domain partial — never the archive failed — when a Work’s repo will not read', async () => {
            // Spec FR-17 / S-13: a shortfall is reported, not hidden, and it
            // costs one domain rather than the other fourteen.
            const source = contentSource(async (id) => {
                if (id === 'w1') throw new Error('data repo unreachable');
                return { ...EMPTY_BACKUP_WORK_CONTENT, items: [{ slug: 'c' }] };
            });

            const h = harness({ rows: WORK_ROWS, workContent: source });
            const result = await h.runner.run('b1', OPTIONS);

            // The archive still finished, and said so honestly.
            expect(result.status).toBe('ready_with_gaps');
            const works = worksDomain(h.terminal());
            expect(works.status).toBe('partial');
            const summary = h.terminal()?.manifestSummary as { domains: { key: string }[] };
            expect(summary.domains).toHaveLength(15);
            // The second Work's content still shipped.
            const names = works.files.map((file) => file.name);
            expect(names).toContain('data/works/content/acme-apps/items.jsonl');
        });

        it('ships the Work rows unchanged when no content source is bound', async () => {
            // A deployment that leaves the port unbound degrades to rows,
            // rather than failing to produce an archive at all.
            const h = harness({ rows: WORK_ROWS });
            const result = await h.runner.run('b1', OPTIONS);

            expect(result.status).toBe('ready');
            const names = worksDomain(h.terminal()).files.map((file) => file.name);
            expect(names).toContain('data/works/works.jsonl');
            expect(names.some((name) => name.includes('/content/'))).toBe(false);
        });
    });

    describe('the App Launcher preference file (APW-11 T30)', () => {
        // T30's "Done when" is a statement about the ARCHIVE, not about the
        // coverage table: a workspace whose owner pinned one item must list
        // `data/account/app-launcher-preferences.jsonl`, and that file must
        // carry the row. So this reads the zip back rather than the manifest —
        // a manifest that named a file the writer never produced is exactly
        // the failure the coverage table's own guard cannot see.
        const PINNED = {
            id: 'p1',
            userId: 'u1',
            scopeKey: 'personal',
            itemKey: 'work:w1',
            visible: true,
            pinned: true,
            pinOrder: 0,
            sortOrder: 0,
        };

        const PREFERENCE_FILE = 'data/account/app-launcher-preferences.jsonl';

        function accountDomain(terminal: Record<string, unknown> | undefined) {
            const summary = terminal?.manifestSummary as {
                domains: {
                    key: string;
                    status: string;
                    records: number;
                    files: { name: string; records: number }[];
                }[];
            };
            return summary.domains.find((domain) => domain.key === 'account')!;
        }

        it('lists it in the manifest and carries the pinned row inside the zip', async () => {
            let archived = Buffer.alloc(0);
            const h = harness({
                rows: {
                    // Every other table present but empty, so the account
                    // domain is complete rather than reported as "this build
                    // does not have it".
                    ...Object.fromEntries(
                        referencedEntities().map((entity) => [
                            entity,
                            [] as Record<string, unknown>[],
                        ]),
                    ),
                    AppLauncherPreference: [PINNED],
                },
                putArchive: jest.fn().mockImplementation(async (source: Readable) => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of source) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
                    }
                    archived = Buffer.concat(chunks);
                    return { key: 'u1/archive.zip', backend: 'fixture-backend' };
                }) as unknown as BackupStorage['putArchive'],
            });

            const result = await h.runner.run('b1', OPTIONS);
            expect(result.status).toBe('ready');

            const account = accountDomain(h.terminal());
            expect(account.files.map((file) => file.name)).toContain(PREFERENCE_FILE);
            expect(account.files.find((file) => file.name === PREFERENCE_FILE)?.records).toBe(1);

            const zip = await JSZip.loadAsync(archived);
            const entry = zip.file(PREFERENCE_FILE);
            expect(entry).not.toBeNull();
            const lines = (await entry!.async('string')).trim().split('\n').filter(Boolean);
            expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([PINNED]);
        });
    });

    it('applies the smaller ceiling when the backend cannot take a stream', async () => {
        // A backend without streaming is a smaller limit, never a wrong
        // result — so the run still completes.
        const h = harness({ supportsStreaming: false });
        const result = await h.runner.run('b1', OPTIONS);

        expect(h.storage.supportsStreaming).toHaveBeenCalled();
        expect(result.status).toBe('ready');
    });
});

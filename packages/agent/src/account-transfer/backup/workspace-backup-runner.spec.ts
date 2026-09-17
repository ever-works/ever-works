import { Readable } from 'node:stream';
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
        }),
        getRepository: (entity: string) => ({
            findOne: async () =>
                entity === 'WorkspaceBackup'
                    ? backupRow({ status: state.status })
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
                    (rows[target] ?? []).map((row) =>
                        Object.fromEntries(
                            Object.entries(row).map(([key, value]) => [`entity_${key}`, value]),
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

    it('applies the smaller ceiling when the backend cannot take a stream', async () => {
        // A backend without streaming is a smaller limit, never a wrong
        // result — so the run still completes.
        const h = harness({ supportsStreaming: false });
        const result = await h.runner.run('b1', OPTIONS);

        expect(h.storage.supportsStreaming).toHaveBeenCalled();
        expect(result.status).toBe('ready');
    });
});

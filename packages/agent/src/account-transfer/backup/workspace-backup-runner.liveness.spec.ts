import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { DataSource } from 'typeorm';
import type { WorkspaceBackupRepository } from '../../database/repositories/workspace-backup.repository';
import type { BackupStorage } from './backup-storage';
import {
    EMPTY_BACKUP_WORK_CONTENT,
    type BackupWorkContent,
    type BackupWorkContentSource,
} from './backup-work-content';
import { referencedEntities } from './collectors/domain-specs';
import {
    WorkspaceBackupRunner,
    type WorkspaceBackupRunOptions,
    type WorkspaceBackupRunTuning,
} from './workspace-backup-runner';

/**
 * The Works domain must never look dead while it is working.
 *
 * Two prod backups of a large workspace stopped heartbeating once they reached
 * `works` and were failed as `stalled` sixteen minutes in. The Works domain is
 * the long one: thousands of Work rows and generation-history rows in the
 * database, then a second pass that reads every Work's data repository — a
 * git clone or pull per Work, with the progress report sent only after each
 * Work FINISHED. These specs pin what has to stay true for that domain:
 *
 *  - every file is paged (no query reads more than one page, no `IN (...)`
 *    list exceeds its chunk), and a heartbeat goes out between pages;
 *  - one long step — a slow page, a slow Work — is covered by the keepalive;
 *  - one Work's content read is bounded, and so is the number of Works that
 *    may hit that bound;
 *  - a Work with thousands of items reports progress while it is written.
 *
 * The fixtures are deliberately big — thousands of rows, multi-kilobyte
 * bodies, tens of megabytes in total — because a stream test whose payload
 * fits in one buffer proves nothing about streaming.
 */

const OPTIONS: WorkspaceBackupRunOptions = {
    workspace: { id: 'org-1', slug: 'acme', displayName: 'Acme', kind: 'organization' },
    account: { id: 'u1', displayName: 'Owner', email: 'owner@example.invalid' },
    build: 'test-build',
};

const PAGE_SIZE = 500;
const ID_CHUNK = 500;

type Row = Record<string, unknown>;

interface Filter {
    readonly test: (row: Row) => boolean;
}

/** Everything the harness saw, in order: page queries, heartbeats, content reads. */
type Event =
    | { kind: 'page'; entity: string; offset: number; take: number; at: number }
    | { kind: 'beat'; at: number }
    | { kind: 'domain'; domain: string; at: number };

function harness(
    tables: Record<string, Row[]>,
    options: {
        workContent?: BackupWorkContentSource;
        /** Milliseconds every page query of this entity takes. */
        slowPagesFor?: { entity: string; ms: number };
    } = {},
) {
    const state = { status: 'queued' };
    const events: Event[] = [];
    const inLists: number[] = [];
    const terminal: Row[] = [];
    let archived = Buffer.alloc(0);

    const repository = {
        claimForRun: jest.fn(async () => {
            if (state.status !== 'queued') return false;
            state.status = 'running';
            return true;
        }),
        heartbeat: jest.fn(async (_id: string, patch: Row) => {
            const at = Date.now();
            if (typeof patch.currentDomain === 'string') {
                events.push({ kind: 'domain', domain: patch.currentDomain, at });
            } else {
                events.push({ kind: 'beat', at });
            }
            return state.status === 'running';
        }),
        markTerminal: jest.fn(async (_id: string, patch: Row) => {
            terminal.push(patch);
            state.status = String(patch.status);
            return true;
        }),
    };

    const columnsOf = (entity: string): string[] => {
        const sample = tables[entity]?.[0];
        return sample ? Object.keys(sample) : ['id', 'userId', 'organizationId', 'createdAt'];
    };

    const dataSource = {
        hasMetadata: (entity: string) => entity in tables,
        getMetadata: (entity: string) => ({
            target: entity,
            columns: columnsOf(entity).map((propertyName) => ({
                propertyName,
                isPrimary: propertyName === 'id',
                isNullable: propertyName !== 'id',
            })),
            primaryColumns: [{ propertyName: 'id' }],
        }),
        getRepository: (entity: string) => ({
            findOne: async () =>
                entity === 'WorkspaceBackup'
                    ? {
                          id: 'b1',
                          userId: 'u1',
                          organizationId: 'org-1',
                          tenantId: 't1',
                          status: state.status,
                          includeFullHistory: false,
                      }
                    : null,
        }),
        // An in-memory query builder that honours the WHERE clauses the row
        // source writes, its ORDER BY, and — the point — skip/take. A fake
        // that returned the whole table for every page would loop forever on
        // a table larger than one page, and prove nothing about paging.
        createQueryBuilder: () => {
            let target = '';
            let offset = 0;
            let take: number | undefined;
            const filters: Filter[] = [];
            const matching = () =>
                (tables[target] ?? [])
                    .filter((row) => filters.every((filter) => filter.test(row)))
                    .sort(
                        (a, b) =>
                            Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0) ||
                            String(a.id).localeCompare(String(b.id)),
                    );
            const builder: Record<string, unknown> = {
                select: () => builder,
                from: (entity: unknown) => {
                    target = String(entity);
                    return builder;
                },
                andWhere: (sql: string, params: Record<string, unknown> = {}) => {
                    const column = /^entity\.(\w+)/.exec(sql)?.[1] ?? '';
                    if (sql.endsWith('IS NULL')) {
                        filters.push({ test: (row) => row[column] == null });
                    } else if (sql.includes('IN (:...withinIds)')) {
                        const ids = new Set(params.withinIds as string[]);
                        inLists.push(ids.size);
                        filters.push({ test: (row) => ids.has(String(row[column])) });
                    } else if (sql.includes('>= :trimCutoff')) {
                        const cutoff = (params.trimCutoff as Date).getTime();
                        filters.push({ test: (row) => Number(row[column]) >= cutoff });
                    } else if (sql.includes('< :trimCutoff')) {
                        const cutoff = (params.trimCutoff as Date).getTime();
                        filters.push({ test: (row) => Number(row[column]) < cutoff });
                    } else {
                        const [value] = Object.values(params);
                        filters.push({ test: (row) => row[column] === value });
                    }
                    return builder;
                },
                orderBy: () => builder,
                addOrderBy: () => builder,
                skip: (value: number) => {
                    offset = value;
                    return builder;
                },
                take: (value: number) => {
                    take = value;
                    return builder;
                },
                getCount: async () => matching().length,
                getRawMany: async () => {
                    events.push({
                        kind: 'page',
                        entity: target,
                        offset,
                        take: take ?? Number.POSITIVE_INFINITY,
                        at: Date.now(),
                    });
                    if (options.slowPagesFor?.entity === target) {
                        await new Promise((resolve) => setTimeout(resolve, options.slowPagesFor!.ms));
                    }
                    return matching()
                        .slice(offset, take === undefined ? undefined : offset + take)
                        .map((row) =>
                            Object.fromEntries(
                                Object.entries(row).map(([key, value]) => [`entity_${key}`, value]),
                            ),
                        );
                },
            };
            return builder;
        },
    } as unknown as DataSource;

    const storage = {
        warmUp: jest.fn().mockResolvedValue(undefined),
        supportsStreaming: jest.fn().mockReturnValue(true),
        backendName: jest.fn().mockReturnValue('fixture-backend'),
        putArchive: jest.fn(async (source: Readable) => {
            const chunks: Buffer[] = [];
            for await (const chunk of source) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
            }
            archived = Buffer.concat(chunks);
            return { key: 'u1/archive.zip', backend: 'fixture-backend' };
        }),
        getArchiveStream: jest.fn(),
        readObject: jest.fn(),
        deleteArchive: jest.fn().mockResolvedValue(undefined),
    } as unknown as BackupStorage;

    const runner = new WorkspaceBackupRunner(
        repository as unknown as WorkspaceBackupRepository,
        dataSource,
        storage,
        options.workContent,
    );

    return {
        runner,
        repository,
        events,
        inLists,
        terminal: () => terminal[terminal.length - 1],
        archive: () => archived,
        /** Events from the moment the run reached `domain` until it reached the next one. */
        during(domain: string): Event[] {
            const start = events.findIndex((e) => e.kind === 'domain' && e.domain === domain);
            if (start < 0) return [];
            const rest = events.slice(start + 1);
            const end = rest.findIndex((e) => e.kind === 'domain');
            return end < 0 ? rest : rest.slice(0, end);
        },
    };
}

/** Every table any domain reads, empty, so no domain is "not in this build". */
function emptyTables(): Record<string, Row[]> {
    return Object.fromEntries(referencedEntities().map((entity) => [entity, [] as Row[]]));
}

function run(h: ReturnType<typeof harness>, tuning: WorkspaceBackupRunTuning) {
    return h.runner.run('b1', { ...OPTIONS, tuning });
}

function worksDomain(terminal: Row | undefined) {
    const summary = terminal?.manifestSummary as {
        domains: {
            key: string;
            status: string;
            records: number;
            error?: { code: string };
            files: { name: string; records: number }[];
        }[];
    };
    return summary.domains.find((domain) => domain.key === 'works')!;
}

async function linesOf(archive: Buffer, name: string): Promise<string[]> {
    const zip = await JSZip.loadAsync(archive);
    const entry = zip.file(name);
    if (!entry) throw new Error(`${name} is not in the archive`);
    return (await entry.async('string')).split('\n').filter(Boolean);
}

/** A string of `bytes` characters that does not compress to nothing. */
function body(seed: number, bytes: number): string {
    let out = '';
    let value = seed * 2654435761;
    while (out.length < bytes) {
        value = (value * 1103515245 + 12345) % 2147483648;
        out += value.toString(36);
    }
    return out.slice(0, bytes);
}

const T0 = Date.UTC(2026, 0, 1);

function work(index: number, userId = 'u1'): Row {
    return {
        id: `w-${String(index).padStart(5, '0')}`,
        slug: `work-${index}`,
        userId,
        organizationId: 'org-1',
        createdAt: T0 + index * 1000,
    };
}

describe('the Works domain of a large workspace', () => {
    const WORKS = 2_600; // 6 pages, and 6 chunks of parent ids
    const HISTORY = 3_000; // 6 pages of ~6 KB rows: ~18 MB of JSON
    const DEPLOYMENTS = 1_300;

    function largeWorkspace(): Record<string, Row[]> {
        const works = Array.from({ length: WORKS }, (_, i) => work(i));
        return {
            ...emptyTables(),
            // Another account's Works and history share the tables and must
            // never ride along — paging must not loosen the scope.
            Work: [...works, work(90_000, 'u2'), work(90_001, 'u2')],
            WorkGenerationHistory: [
                ...Array.from({ length: HISTORY }, (_, i) => ({
                    id: `h-${String(i).padStart(5, '0')}`,
                    workId: works[i % WORKS]!.id,
                    userId: 'u1',
                    organizationId: 'org-1',
                    createdAt: T0 + i * 10,
                    logs: [{ step: 'generate', message: body(i, 6_000) }],
                })),
                {
                    id: 'h-foreign',
                    workId: 'w-90000',
                    userId: 'u2',
                    organizationId: 'org-1',
                    createdAt: T0,
                    logs: [],
                },
            ],
            // Parent-scoped through the 2,600 registered Work ids.
            WorkDeployment: Array.from({ length: DEPLOYMENTS }, (_, i) => ({
                id: `d-${String(i).padStart(5, '0')}`,
                workId: works[(i * 7) % WORKS]!.id,
                createdAt: T0 + i,
                status: 'ready',
            })),
        };
    }

    it('pages every file, chunks every id list, and heartbeats between pages', async () => {
        const h = harness(largeWorkspace());
        // Every page heartbeat goes to the database; the keepalive is parked
        // so the beats counted here are the per-page ones alone.
        const result = await run(h, { heartbeatIntervalMs: 0, keepaliveIntervalMs: 3_600_000 });

        expect(result.status).toBe('ready');

        const works = h.during('works');
        const pages = works.filter(
            (e): e is Extract<Event, { kind: 'page' }> => e.kind === 'page',
        );
        // No query ever asked for more than one page.
        expect(pages.length).toBeGreaterThan(0);
        expect(Math.max(...pages.map((p) => p.take))).toBeLessThanOrEqual(PAGE_SIZE);
        // And no IN (...) list ever carried more than one chunk of ids.
        expect(Math.max(...h.inLists)).toBeLessThanOrEqual(ID_CHUNK);

        // The Work file itself walked 0, 500, …, 2500.
        const workOffsets = pages.filter((p) => p.entity === 'Work').map((p) => p.offset);
        expect(workOffsets).toEqual(
            expect.arrayContaining([0, 500, 1000, 1500, 2000, 2500]),
        );

        // Between two consecutive full pages of the same file there is always
        // a heartbeat: one long file is never one silent step.
        for (const entity of ['Work', 'WorkGenerationHistory']) {
            const indices = works
                .map((event, index) => ({ event, index }))
                .filter(({ event }) => event.kind === 'page' && event.entity === entity)
                .map(({ index }) => index);
            expect(indices.length).toBeGreaterThanOrEqual(6);
            for (let i = 1; i < indices.length; i += 1) {
                const between = works.slice(indices[i - 1]! + 1, indices[i]);
                expect(between.some((event) => event.kind === 'beat')).toBe(true);
            }
        }

        // Every row arrived, exactly once, and nobody else's did.
        const domain = worksDomain(h.terminal());
        const records = (name: string) =>
            domain.files.find((file) => file.name === `data/works/${name}`)?.records;
        expect(records('works.jsonl')).toBe(WORKS);
        expect(records('generation-history.jsonl')).toBe(HISTORY);
        expect(records('deployments.jsonl')).toBe(DEPLOYMENTS);

        const workLines = await linesOf(h.archive(), 'data/works/works.jsonl');
        expect(workLines).toHaveLength(WORKS);
        expect(new Set(workLines.map((line) => (JSON.parse(line) as Row).id)).size).toBe(WORKS);
        expect(workLines.some((line) => line.includes('"userId":"u2"'))).toBe(false);

        const historyLines = await linesOf(h.archive(), 'data/works/generation-history.jsonl');
        expect(historyLines).toHaveLength(HISTORY);
        // The bodies made it through whole: far more bytes than any buffer.
        expect(historyLines.reduce((sum, line) => sum + line.length, 0)).toBeGreaterThan(
            HISTORY * 6_000,
        );
    }, 120_000);

    it('keeps heartbeating through ONE slow page — the step the per-page beat cannot cover', async () => {
        // A single page that takes far longer than the keepalive period: the
        // per-page beat only fires when the page is DONE, so without the
        // keepalive this whole wait is silent.
        const h = harness(
            { ...emptyTables(), Work: Array.from({ length: 3 }, (_, i) => work(i)) },
            { slowPagesFor: { entity: 'Work', ms: 400 } },
        );
        const result = await run(h, { heartbeatIntervalMs: 20 });

        expect(result.status).toBe('ready');
        const works = h.during('works');
        const page = works.findIndex((e) => e.kind === 'page' && e.entity === 'Work');
        const pageAt = (works[page] as { at: number }).at;
        const beatsDuringPage = works.filter(
            (e) => e.kind === 'beat' && e.at > pageAt && e.at < pageAt + 400,
        );
        expect(beatsDuringPage.length).toBeGreaterThanOrEqual(5);
    }, 30_000);
});

describe('the Works content pass — one data repo per Work', () => {
    function tablesWith(count: number): Record<string, Row[]> {
        return { ...emptyTables(), Work: Array.from({ length: count }, (_, i) => work(i)) };
    }

    function source(
        impl: (slug: string) => Promise<BackupWorkContent>,
    ): BackupWorkContentSource & { calls: string[] } {
        const calls: string[] = [];
        return {
            calls,
            readWorkContent: async (ref) => {
                calls.push(ref.slug);
                return impl(ref.slug);
            },
        };
    }

    const never = () => new Promise<BackupWorkContent>(() => undefined);

    it('heartbeats while one Work’s repo takes a long time to read', async () => {
        let readStarted = 0;
        let readEnded = 0;
        const content = source(async () => {
            readStarted = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 400));
            readEnded = Date.now();
            return { ...EMPTY_BACKUP_WORK_CONTENT, items: [{ slug: 'a' }] };
        });
        const h = harness(tablesWith(1), { workContent: content });

        const result = await run(h, { heartbeatIntervalMs: 20 });

        expect(result.status).toBe('ready');
        const beats = h
            .during('works')
            .filter((e) => e.kind === 'beat' && e.at > readStarted && e.at < readEnded);
        // ~20 keepalive ticks fit in the read; demand a fraction of them, so a
        // loaded CI machine does not flake this, while a silent wait (zero)
        // still fails it.
        expect(beats.length).toBeGreaterThanOrEqual(5);
    }, 30_000);

    it('reports progress every few hundred rows of one Work with thousands of items', async () => {
        const ITEMS = 5_000;
        const content = source(async () => ({
            ...EMPTY_BACKUP_WORK_CONTENT,
            items: Array.from({ length: ITEMS }, (_, i) => ({
                slug: `item-${i}`,
                description: body(i, 1_000),
            })),
        }));
        const h = harness(tablesWith(1), { workContent: content });

        // Keepalive parked: these beats come from the rows themselves.
        const result = await run(h, { heartbeatIntervalMs: 0, keepaliveIntervalMs: 3_600_000 });

        expect(result.status).toBe('ready');
        const beats = h.during('works').filter((e) => e.kind === 'beat');
        expect(beats.length).toBeGreaterThanOrEqual(ITEMS / 500);

        const lines = await linesOf(h.archive(), 'data/works/content/work-0/items.jsonl');
        expect(lines).toHaveLength(ITEMS);
    }, 60_000);

    it('moves on from a Work whose repo never answers, and reports it as a gap', async () => {
        const content = source(async (slug) =>
            slug === 'work-0'
                ? never()
                : { ...EMPTY_BACKUP_WORK_CONTENT, items: [{ slug: `${slug}-item` }] },
        );
        const h = harness(tablesWith(3), { workContent: content });

        const started = Date.now();
        const result = await run(h, { workContentTimeoutMs: 100 });

        // Not the hour's ceiling: the archive finished, honestly incomplete.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(result.status).toBe('ready_with_gaps');
        expect(content.calls).toEqual(['work-0', 'work-1', 'work-2']);

        const domain = worksDomain(h.terminal());
        expect(domain.status).toBe('partial');
        expect(domain.error?.code).toBe('work_content_unavailable');
        const names = domain.files.map((file) => file.name);
        expect(names).not.toContain('data/works/content/work-0/items.jsonl');
        expect(names).toContain('data/works/content/work-1/items.jsonl');
        expect(names).toContain('data/works/content/work-2/items.jsonl');
        // The fourteen other domains still ran.
        const summary = h.terminal()?.manifestSummary as { domains: unknown[] };
        expect(summary.domains).toHaveLength(15);
    }, 30_000);

    it('stops reading repos after the timeout budget is spent, reporting the rest as gaps', async () => {
        const content = source(never);
        const h = harness(tablesWith(6), { workContent: content });

        const result = await run(h, { workContentTimeoutMs: 50, workContentTimeoutBudget: 2 });

        expect(result.status).toBe('ready_with_gaps');
        // Two attempts, not six: a struggling git host costs two bounds.
        expect(content.calls).toEqual(['work-0', 'work-1']);
        const domain = worksDomain(h.terminal());
        expect(domain.status).toBe('partial');
        expect(domain.error?.code).toBe('work_content_unavailable');
        // The Work ROWS still shipped, all six.
        expect(domain.files.find((file) => file.name === 'data/works/works.jsonl')?.records).toBe(6);
        expect(domain.files.some((file) => file.name.includes('/content/'))).toBe(false);
    }, 30_000);

    it('never cuts a Work’s content short because a progress write failed', async () => {
        const ITEMS = 2_000;
        const content = source(async (slug) => ({
            ...EMPTY_BACKUP_WORK_CONTENT,
            items: Array.from({ length: ITEMS }, (_, i) => ({ slug: `${slug}-${i}`, n: i })),
        }));
        const h = harness(tablesWith(2), { workContent: content });
        // Every progress write inside the Works domain fails (the
        // domain-boundary reports, which carry `currentDomain`, still land).
        let current = '';
        h.repository.heartbeat.mockImplementation(async (_id: string, patch: Row) => {
            if (typeof patch.currentDomain === 'string') {
                current = patch.currentDomain;
                h.events.push({ kind: 'domain', domain: current, at: Date.now() });
                return true;
            }
            if (current === 'works') throw new Error('heartbeat write failed');
            return true;
        });

        const result = await run(h, { heartbeatIntervalMs: 0, keepaliveIntervalMs: 3_600_000 });

        expect(result.status).toBe('ready');
        const domain = worksDomain(h.terminal());
        expect(domain.status).toBe('complete');
        for (const slug of ['work-0', 'work-1']) {
            const lines = await linesOf(h.archive(), `data/works/content/${slug}/items.jsonl`);
            expect(lines).toHaveLength(ITEMS);
        }
    }, 30_000);

    it('stops the keepalive when the run ends, so nothing reports a settled backup alive', async () => {
        const content = source(async () => EMPTY_BACKUP_WORK_CONTENT);
        const h = harness(tablesWith(1), { workContent: content });

        await run(h, { heartbeatIntervalMs: 10 });
        const after = h.repository.heartbeat.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(h.repository.heartbeat.mock.calls.length).toBe(after);
    }, 30_000);
});

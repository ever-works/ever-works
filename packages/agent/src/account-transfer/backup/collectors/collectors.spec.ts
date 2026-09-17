import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_DOMAINS, BACKUP_TRIM_POLICIES } from '@ever-works/contracts';
import { AGENT_ENTITY_NAMES } from '../../../database/_entity-names';
import { BACKUP_DROPPED_ENTITIES } from '../redaction';
import { BACKUP_COLLECTORS, getBackupCollector, missingCollectorKeys } from './index';
import { BACKUP_DOMAIN_SPECS, referencedEntities } from './domain-specs';
import { EntityBackupCollector, withRetries } from './entity-collector';
import type {
    BackupCollectContext,
    BackupEntityQuery,
    BackupRowSource,
    QueuedBackupFile,
} from './collector.types';

/**
 * The coverage table is the archive's promise. These assertions are the ones
 * that fail when the promise stops being true — a domain with nothing behind
 * it, a table name that no longer exists, a child file reached before its
 * parent registered any ids, or a query that reaches outside the workspace
 * that asked for it.
 */

/** Entity names this build actually knows, from every barrel the specs may reference. */
function knownEntities(): Set<string> {
    const names = new Set<string>(AGENT_ENTITY_NAMES);
    for (const dir of [
        join(__dirname, '..', '..', '..', 'plugins', 'entities'),
        join(__dirname, '..', '..', 'entities'),
    ]) {
        let files: string[];
        try {
            files = readdirSync(dir).filter((name) => name.endsWith('.entity.ts'));
        } catch {
            continue;
        }
        for (const file of files) {
            const match = /export class ([A-Za-z0-9_]+)/.exec(
                readFileSync(join(dir, file), 'utf8'),
            );
            if (match) names.add(match[1]);
        }
    }
    return names;
}

/** The columns one entity declares, read from its source. */
function columnsOf(entity: string): Set<string> {
    for (const dir of [
        join(__dirname, '..', '..', '..', 'entities'),
        join(__dirname, '..', '..', '..', 'plugins', 'entities'),
        join(__dirname, '..', '..', 'entities'),
    ]) {
        let files: string[];
        try {
            files = readdirSync(dir).filter((name) => name.endsWith('.entity.ts'));
        } catch {
            continue;
        }
        for (const file of files) {
            const source = readFileSync(join(dir, file), 'utf8');
            if (!new RegExp(`export class ${entity}\\b`).test(source)) continue;
            const columns = new Set<string>();
            for (const line of source.split('\n')) {
                const property = /^\s{4}(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
                if (property) columns.add(property[1]);
            }
            return columns;
        }
    }
    return new Set();
}

/** A row source over fixture rows, so collectors are testable without a database. */
class FixtureRowSource implements BackupRowSource {
    readonly queries: BackupEntityQuery[] = [];

    constructor(
        private readonly rows: Record<string, Record<string, unknown>[]>,
        private readonly columns: Record<string, string[]> = {},
    ) {}

    hasEntity(entity: string): boolean {
        return entity in this.rows;
    }

    hasColumn(entity: string, column: string): boolean {
        return (this.columns[entity] ?? Object.keys(this.rows[entity]?.[0] ?? {})).includes(column);
    }

    async page(query: BackupEntityQuery, offset: number, limit: number) {
        this.queries.push(query);
        return (this.rows[query.entity] ?? []).slice(offset, offset + limit);
    }

    async countTrimmed(): Promise<number> {
        return 0;
    }
}

function contextFor(
    source: BackupRowSource,
    overrides: Partial<BackupCollectContext> = {},
): BackupCollectContext {
    const ids = new Map<string, readonly string[]>();
    return {
        scope: { userId: 'u1', organizationId: 'org-1', tenantId: 't1' },
        includeFullHistory: false,
        now: new Date('2026-09-06T00:00:00.000Z'),
        source,
        pageSize: 2,
        enqueueFile: () => undefined,
        registerIds: (name, value) => ids.set(name, value),
        idsFor: (name) => ids.get(name) ?? [],
        shouldStop: () => false,
        heartbeat: async () => undefined,
        ...overrides,
    };
}

describe('the collector registry', () => {
    it('covers every domain the format publishes', () => {
        expect(missingCollectorKeys()).toEqual([]);
        expect(BACKUP_COLLECTORS.size).toBe(BACKUP_DOMAINS.length);
        expect(BACKUP_COLLECTORS.size).toBe(15);
    });

    it('registers each collector under its own domain key', () => {
        for (const domain of BACKUP_DOMAINS) {
            expect(getBackupCollector(domain.key)?.key).toBe(domain.key);
        }
    });

    it('has no collector for a key the format does not publish', () => {
        expect(getBackupCollector('nope' as never)).toBeUndefined();
    });
});

describe('the coverage table', () => {
    it('lists one spec per domain, in the published order', () => {
        expect(BACKUP_DOMAIN_SPECS.map((spec) => spec.key)).toEqual(
            BACKUP_DOMAINS.map((domain) => domain.key),
        );
    });

    it('gives every domain at least one file', () => {
        for (const spec of BACKUP_DOMAIN_SPECS) {
            expect(spec.files.length).toBeGreaterThan(0);
        }
    });

    it('names only entities this build actually has', () => {
        const known = knownEntities();
        const unknown = referencedEntities().filter((entity) => !known.has(entity));
        expect(unknown).toEqual([]);
    });

    it('never names an entity on the never-exported list', () => {
        const dropped = referencedEntities().filter((entity) =>
            BACKUP_DROPPED_ENTITIES.includes(entity),
        );
        expect(dropped).toEqual([]);
    });

    it('gives every file a unique path within its domain', () => {
        for (const spec of BACKUP_DOMAIN_SPECS) {
            const names = spec.files.map((file) => file.file);
            expect(new Set(names).size).toBe(names.length);
        }
    });

    it('scopes every file by something — never by nothing', () => {
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                expect(['owner', 'user', 'workspace', 'organization', 'parent']).toContain(
                    file.scope.by,
                );
            }
        }
    });

    it('only scopes by a column the entity actually declares', () => {
        const problems: string[] = [];
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                const columns = columnsOf(file.entity);
                if (columns.size === 0) continue;
                const required =
                    file.scope.by === 'user'
                        ? ['userId']
                        : file.scope.by === 'organization'
                          ? ['organizationId']
                          : file.scope.by === 'workspace'
                            ? ['userId']
                            : file.scope.by === 'parent'
                              ? [file.scope.column]
                              : ['id'];
                for (const column of required) {
                    if (!columns.has(column)) {
                        problems.push(`${spec.key}/${file.file}: ${file.entity} has no ${column}`);
                    }
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('never reaches for a parent id set before something registers it', () => {
        // Domains are walked in published order, so a `parent` file may only
        // use ids registered earlier in its own domain or in an earlier one.
        const registered = new Set<string>();
        const problems: string[] = [];
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                if (file.scope.by === 'parent' && !registered.has(file.scope.from)) {
                    problems.push(`${spec.key}/${file.file} wants ${file.scope.from}`);
                }
                if (file.registerIdsAs) registered.add(file.registerIdsAs);
            }
        }
        expect(problems).toEqual([]);
    });

    it('names only trim policies the format defines', () => {
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                if (!file.trim) continue;
                expect(Object.keys(BACKUP_TRIM_POLICIES)).toContain(file.trim);
            }
        }
    });

    it('trims every history-shaped table spec FR-14 names', () => {
        const trimmed = new Set(
            BACKUP_DOMAIN_SPECS.flatMap((spec) =>
                spec.files.filter((f) => f.trim).map((f) => f.entity),
            ),
        );
        for (const entity of [
            'ActivityLog',
            'AgentRunLog',
            'TerminalTranscriptChunk',
            'Notification',
            'PluginUsageEvent',
            'NotificationChannelDeliveryLog',
            'WebhookDelivery',
            'InboundTriggerFire',
            'KbRetrievalLog',
            'FleetJob',
        ]) {
            expect(trimmed).toContain(entity);
        }
    });

    it('carries the uploads that actually have bytes, and only those', () => {
        const withBytes = BACKUP_DOMAIN_SPECS.flatMap((spec) =>
            spec.files.filter((file) => file.bytes).map((file) => file.entity),
        );
        expect(withBytes.sort()).toEqual(['UserUpload', 'WorkKnowledgeUpload']);
    });
});

describe('EntityBackupCollector', () => {
    const spec = BACKUP_DOMAIN_SPECS.find((candidate) => candidate.key === 'agents')!;

    it('scopes a workspace query by both the person and the organization', async () => {
        const source = new FixtureRowSource(
            { Agent: [] },
            { Agent: ['id', 'userId', 'organizationId'] },
        );
        const collector = new EntityBackupCollector(spec);
        const plans = await collector.plan(contextFor(source));
        const agents = plans.find((plan) => plan.file === 'agents.jsonl');

        expect(agents?.query.equals).toEqual({ userId: 'u1', organizationId: 'org-1' });
    });

    it('scopes the un-organized workspace to rows with no organization at all', async () => {
        const source = new FixtureRowSource(
            { Agent: [] },
            { Agent: ['id', 'userId', 'organizationId'] },
        );
        const collector = new EntityBackupCollector(spec);
        const plans = await collector.plan(
            contextFor(source, { scope: { userId: 'u1', organizationId: null, tenantId: null } }),
        );

        // `null` becomes `IS NULL`, which is what keeps a personal backup from
        // sweeping up every organization the person also belongs to.
        expect(plans.find((plan) => plan.file === 'agents.jsonl')?.query.equals).toEqual({
            userId: 'u1',
            organizationId: null,
        });
    });

    it('reaches child rows only through ids their parent registered', async () => {
        const source = new FixtureRowSource(
            {
                Agent: [{ id: 'a1', userId: 'u1', organizationId: 'org-1' }],
                AgentMembership: [{ id: 'm1', agentId: 'a1' }],
            },
            { Agent: ['id', 'userId', 'organizationId'], AgentMembership: ['id', 'agentId'] },
        );
        const collector = new EntityBackupCollector(spec);
        const context = contextFor(source);

        const first = await collector.plan(context);
        // Drain agents.jsonl so its ids get registered.
        for await (const _row of collector.rows(
            context,
            first.find((p) => p.file === 'agents.jsonl')!,
        )) {
            void _row;
        }

        const second = await collector.plan(context);
        expect(second.find((plan) => plan.file === 'memberships.jsonl')?.query.within).toEqual({
            column: 'agentId',
            ids: ['a1'],
        });
    });

    it('yields nothing for a child whose parent registered no ids, rather than everything', async () => {
        // The failure this prevents: an empty `IN ()` silently dropped from a
        // predicate, turning "this workspace's memberships" into "all of them".
        const source = new FixtureRowSource(
            { Agent: [], AgentMembership: [{ id: 'm1', agentId: 'someone-elses-agent' }] },
            { Agent: ['id', 'userId', 'organizationId'], AgentMembership: ['id', 'agentId'] },
        );
        const collector = new EntityBackupCollector(spec);
        const context = contextFor(source);
        const plans = await collector.plan(context);

        const rows = [];
        for await (const row of collector.rows(
            context,
            plans.find((p) => p.file === 'memberships.jsonl')!,
        )) {
            rows.push(row);
        }
        expect(rows).toEqual([]);
    });

    it('writes an empty file for an entity this build does not have', async () => {
        const collector = new EntityBackupCollector(spec);
        const context = contextFor(new FixtureRowSource({}));
        const plans = await collector.plan(context);

        expect(plans.every((plan) => plan.unavailable)).toBe(true);
        const rows = [];
        for await (const row of collector.rows(context, plans[0])) rows.push(row);
        expect(rows).toEqual([]);
    });

    it('redacts every row it yields', async () => {
        const source = new FixtureRowSource(
            {
                Agent: [
                    {
                        id: 'a1',
                        userId: 'u1',
                        organizationId: 'org-1',
                        secretEncrypted: 'sk-live-1',
                    },
                ],
            },
            { Agent: ['id', 'userId', 'organizationId', 'secretEncrypted'] },
        );
        const collector = new EntityBackupCollector(spec);
        const context = contextFor(source);
        const plans = await collector.plan(context);

        const rows = [];
        for await (const row of collector.rows(
            context,
            plans.find((p) => p.file === 'agents.jsonl')!,
        )) {
            rows.push(row);
        }
        expect(rows[0].secretEncrypted).toEqual({ wasSet: true });
        expect(JSON.stringify(rows)).not.toContain('sk-live-1');
    });

    it('pages rather than loading a table at once', async () => {
        const source = new FixtureRowSource(
            {
                Agent: Array.from({ length: 5 }, (_, i) => ({
                    id: `a${i}`,
                    userId: 'u1',
                    organizationId: 'org-1',
                })),
            },
            { Agent: ['id', 'userId', 'organizationId'] },
        );
        const collector = new EntityBackupCollector(spec);
        const context = contextFor(source, { pageSize: 2 });
        const plans = await collector.plan(context);

        const rows = [];
        for await (const row of collector.rows(
            context,
            plans.find((p) => p.file === 'agents.jsonl')!,
        )) {
            rows.push(row);
        }
        expect(rows).toHaveLength(5);
        // 2 + 2 + 1 — the short page ends the walk.
        expect(source.queries.filter((q) => q.entity === 'Agent')).toHaveLength(3);
    });

    it('stops between pages when the backup is cancelled', async () => {
        const source = new FixtureRowSource(
            {
                Agent: Array.from({ length: 5 }, (_, i) => ({
                    id: `a${i}`,
                    userId: 'u1',
                    organizationId: 'org-1',
                })),
            },
            { Agent: ['id', 'userId', 'organizationId'] },
        );
        const collector = new EntityBackupCollector(spec);
        let pages = 0;
        const context = contextFor(source, {
            pageSize: 2,
            shouldStop: () => pages++ > 0,
        });
        const plans = await collector.plan(context);

        const rows = [];
        for await (const row of collector.rows(
            context,
            plans.find((p) => p.file === 'agents.jsonl')!,
        )) {
            rows.push(row);
        }
        expect(rows.length).toBeLessThan(5);
    });

    it('queues an upload’s bytes while writing its metadata row', async () => {
        const knowledge = BACKUP_DOMAIN_SPECS.find((candidate) => candidate.key === 'knowledge')!;
        const source = new FixtureRowSource(
            {
                WorkKnowledgeUpload: [
                    {
                        id: 'up-1',
                        workId: 'w1',
                        storagePath: 'u1/abc.pdf',
                        originalFilename: 'report.pdf',
                        fileSize: 1024,
                    },
                ],
            },
            {
                WorkKnowledgeUpload: [
                    'id',
                    'workId',
                    'storagePath',
                    'originalFilename',
                    'fileSize',
                ],
            },
        );
        const queued: QueuedBackupFile[] = [];
        const collector = new EntityBackupCollector(knowledge);
        const context = contextFor(source, { enqueueFile: (file) => queued.push(file) });
        (context as { idsFor: (name: string) => readonly string[] }).idsFor = () => ['w1'];

        const plans = await collector.plan(context);
        const rows = [];
        for await (const row of collector.rows(
            context,
            plans.find((p) => p.file === 'uploads.jsonl')!,
        )) {
            rows.push(row);
        }

        // The metadata row is written whether or not the bytes fit — spec
        // FR-15's guarantee that a too-large file is still described.
        expect(rows).toHaveLength(1);
        expect(queued).toEqual([
            { id: 'up-1', storageKey: 'u1/abc.pdf', filename: 'report.pdf', sizeBytes: 1024 },
        ]);
    });

    it('applies the default trim window, and widens it for full history', async () => {
        const activity = BACKUP_DOMAIN_SPECS.find((candidate) => candidate.key === 'activity')!;
        const source = new FixtureRowSource(
            { ActivityLog: [] },
            { ActivityLog: ['id', 'userId', 'organizationId', 'createdAt'] },
        );
        const collector = new EntityBackupCollector(activity);

        const now = new Date('2026-09-06T00:00:00.000Z');
        const standard = await collector.plan(contextFor(source, { now }));
        const full = await collector.plan(contextFor(source, { now, includeFullHistory: true }));

        expect(standard[0].query.trim?.cutoff.toISOString()).toBe('2025-09-06T00:00:00.000Z');
        expect(full[0].query.trim?.cutoff.toISOString()).toBe('2023-09-07T00:00:00.000Z');
    });

    it('skips a trim the entity has no column for, rather than querying a column that is not there', async () => {
        const activity = BACKUP_DOMAIN_SPECS.find((candidate) => candidate.key === 'activity')!;
        const source = new FixtureRowSource({ ActivityLog: [] }, { ActivityLog: ['id', 'userId'] });
        const plans = await new EntityBackupCollector(activity).plan(contextFor(source));
        expect(plans[0].query.trim).toBeUndefined();
    });
});

describe('withRetries', () => {
    it('gives a transient failure two more goes before it gives up (spec FR-17)', async () => {
        let attempts = 0;
        const result = await withRetries(async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('connection reset');
            return 'ok';
        });
        expect(result).toBe('ok');
        expect(attempts).toBe(3);
    });

    it('rethrows once the retries are spent, so the domain can be marked failed', async () => {
        let attempts = 0;
        await expect(
            withRetries(async () => {
                attempts += 1;
                throw new Error('still down');
            }),
        ).rejects.toThrow('still down');
        expect(attempts).toBe(3);
    });
});

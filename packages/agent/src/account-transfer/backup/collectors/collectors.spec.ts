import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_DOMAINS, BACKUP_TRIM_POLICIES } from '@ever-works/contracts';
import { AGENT_ENTITY_NAMES } from '../../../database/_entity-names';
import { BACKUP_DROPPED_ENTITIES, shouldDropEntirely } from '../redaction';
import { BACKUP_COLLECTORS, getBackupCollector, missingCollectorKeys } from './index';
import { BACKUP_DOMAIN_SPECS, referencedEntities } from './domain-specs';
import { EntityBackupCollector, withRetries } from './entity-collector';
import type {
    BackupCollectContext,
    BackupEntityQuery,
    BackupFileSpec,
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

    it('names a trim field that is a real column of the entity it trims', () => {
        // The trim resolver fails OPEN: an unknown column means NO trim, no
        // error and no trim record in the manifest. So a policy pointed at a
        // column that does not exist is a window that silently never
        // applies, and both `pluginUsageEvents` and `triggerFires` said
        // `createdAt` on entities that name their creation timestamp
        // `occurredAt` and `firedAt`. `plugin_usage_events` is the archive's
        // largest history table, and the docs page publishes the 180-day
        // window it was not applying.
        const wrong: string[] = [];
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                if (!file.trim) continue;
                const policy = BACKUP_TRIM_POLICIES[file.trim];
                expect(policy).toBeDefined();
                const columns = columnsOf(file.entity);
                // An entity this build does not carry has no columns to
                // check; `collectors.spec.ts` asserts entity existence
                // separately.
                if (columns.size === 0) continue;
                if (!columns.has(policy.field)) {
                    wrong.push(`${file.entity}.${policy.field} (policy ${file.trim})`);
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    it('carries the uploads that actually have bytes, and only those', () => {
        const withBytes = BACKUP_DOMAIN_SPECS.flatMap((spec) =>
            spec.files.filter((file) => file.bytes).map((file) => file.entity),
        );
        expect(withBytes.sort()).toEqual(['UserUpload', 'WorkKnowledgeUpload']);
    });
});

/**
 * APW-11 T30 (R-25). The App Launcher's preference table is one of the newest
 * things the coverage table carries, and there are two opposite ways to get it
 * wrong. Classified `workspace`, an `organizationId` predicate lands on a table
 * that has no such column — so the person who actually pinned something gets an
 * empty file. Classified twice, a restore has two sources for one arrangement
 * and no rule for which wins. Both are asserted against here, together with the
 * pointer the exposure flag needs: `Work.appLauncherExposed` is a column of the
 * entity `works/works.jsonl` already exports, so it opens no second file.
 */
describe('the App Launcher preference table (APW-11 T30)', () => {
    /** Every file spec naming `entity`, with the domain it sits in. */
    function placementsOf(entity: string): { domain: string; file: BackupFileSpec }[] {
        return BACKUP_DOMAIN_SPECS.flatMap((spec) =>
            spec.files
                .filter((file) => file.entity === entity)
                .map((file) => ({ domain: spec.key, file })),
        );
    }

    function pathOf(placement: { domain: string; file: BackupFileSpec }): string {
        return `${placement.domain}/${placement.file.file}`;
    }

    it('is classified exactly once, in the account domain, keyed to the person', () => {
        const placements = placementsOf('AppLauncherPreference');

        expect(placements.map(pathOf)).toEqual(['account/app-launcher-preferences.jsonl']);
        // `by: 'user'` is the classification, and it is the one that matters:
        // a row is keyed by `userId` + `scopeKey` (`'global' | 'personal' |
        // <organizationId>`), and an organisation-scoped preference still
        // belongs to the person who set it.
        expect(placements[0].file.scope).toEqual({ by: 'user' });
    });

    it('exports the row rather than dropping it', () => {
        // The collector consults this predicate before it yields anything, so
        // asserting on it is asserting on the walk, not on a list.
        expect(shouldDropEntirely('AppLauncherPreference')).toBe(false);
        expect(BACKUP_DROPPED_ENTITIES).not.toContain('AppLauncherPreference');
    });

    it('plans a query narrowed by the person alone — never by an organization', async () => {
        const account = BACKUP_DOMAIN_SPECS.find((spec) => spec.key === 'account')!;
        const source = new FixtureRowSource(
            { AppLauncherPreference: [] },
            { AppLauncherPreference: ['id', 'userId', 'scopeKey', 'itemKey'] },
        );
        const collector = new EntityBackupCollector(account);

        const organized = await collector.plan(contextFor(source));
        const plan = organized.find(
            (candidate) => candidate.file === 'app-launcher-preferences.jsonl',
        )!;
        expect(plan.unavailable).toBeUndefined();
        expect(plan.query.equals).toEqual({ userId: 'u1' });
        expect(Object.keys(plan.query.equals)).not.toContain('organizationId');

        // And the same query for a personal workspace. A `workspace`-scoped
        // file would have added `organizationId: 'org-1'` above and
        // `organizationId: null` here — either of which is a predicate on a
        // column this table does not declare.
        const personal = await collector.plan(
            contextFor(source, { scope: { userId: 'u1', organizationId: null, tenantId: null } }),
        );
        expect(
            personal.find((candidate) => candidate.file === 'app-launcher-preferences.jsonl')?.query
                .equals,
        ).toEqual({ userId: 'u1' });
    });

    it('leaves Work referenced once, by works/works.jsonl, with the exposure flag on that row', () => {
        const placements = placementsOf('Work');

        expect(placements.map(pathOf)).toEqual(['works/works.jsonl']);
        // T2's flag is a column of the entity that file already exports, which
        // is what makes "no new file" true rather than merely intended.
        expect(columnsOf('Work').has('appLauncherExposed')).toBe(true);
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

    it('registers the ids it did collect when the walk does not finish, and says so', async () => {
        // Registration used to sit AFTER the paging loop, so a page query
        // that spent its retries left the name unregistered ENTIRELY — which
        // is indistinguishable from "this workspace has no agents". A later
        // file scoped by that name then wrote zero records with no error and
        // the coverage table reported the section `empty`.
        const failing: BackupRowSource = {
            hasEntity: () => true,
            hasColumn: () => true,
            page: async (query, offset) => {
                if (query.entity !== 'Agent') return [];
                if (offset === 0) {
                    return [
                        { id: 'a1', userId: 'u1', organizationId: 'org-1' },
                        { id: 'a2', userId: 'u1', organizationId: 'org-1' },
                    ];
                }
                throw new Error('page query failed');
            },
            countTrimmed: async () => 0,
        };

        const registrations = new Map<string, { ids: readonly string[]; complete: boolean }>();
        const context = contextFor(failing, {
            // A page size of 2 makes the first page full, so the loop asks
            // for a second one — which throws.
            pageSize: 2,
            registerIds: (name, ids, complete = true) => registrations.set(name, { ids, complete }),
            idsFor: (name) => registrations.get(name)?.ids ?? [],
            idsComplete: (name) => registrations.get(name)?.complete ?? true,
        });
        const collector = new EntityBackupCollector(spec);

        const first = await collector.plan(context);
        const agents = first.find((plan) => plan.file === 'agents.jsonl')!;
        await expect(
            (async () => {
                for await (const _row of collector.rows(context, agents)) void _row;
            })(),
        ).rejects.toThrow('page query failed');

        // What it managed to read is registered — a partial list is the best
        // any dependent file can do.
        expect(registrations.get('agentIds')?.ids).toEqual(['a1', 'a2']);
        // And the shortfall travels with it.
        expect(registrations.get('agentIds')?.complete).toBe(false);

        // So a file scoped by that name is planned as a gap, not an absence.
        const second = await collector.plan(context);
        expect(second.find((plan) => plan.file === 'memberships.jsonl')?.errorCode).toBe(
            'parent_ids_incomplete',
        );
    });

    it('marks a dependent plan clean when its parent finished', async () => {
        const source = new FixtureRowSource(
            {
                Agent: [{ id: 'a1', userId: 'u1', organizationId: 'org-1' }],
                AgentMembership: [{ id: 'm1', agentId: 'a1' }],
            },
            { Agent: ['id', 'userId', 'organizationId'], AgentMembership: ['id', 'agentId'] },
        );
        const registrations = new Map<string, { ids: readonly string[]; complete: boolean }>();
        const context = contextFor(source, {
            registerIds: (name, ids, complete = true) => registrations.set(name, { ids, complete }),
            idsFor: (name) => registrations.get(name)?.ids ?? [],
            idsComplete: (name) => registrations.get(name)?.complete ?? true,
        });
        const collector = new EntityBackupCollector(spec);

        const first = await collector.plan(context);
        for await (const _row of collector.rows(
            context,
            first.find((p) => p.file === 'agents.jsonl')!,
        )) {
            void _row;
        }

        const second = await collector.plan(context);
        expect(second.find((plan) => plan.file === 'memberships.jsonl')?.errorCode).toBeUndefined();
    });

    it('re-plans a child from its own domain against the ids its parent has since registered', async () => {
        // The runner plans a domain once, before any file is read, so the
        // up-front plan of a same-domain child always holds an empty id list.
        // `replan` is what it calls right before walking the child.
        const source = new FixtureRowSource(
            {
                Agent: [{ id: 'a1', userId: 'u1', organizationId: 'org-1' }],
                AgentMembership: [{ id: 'm1', agentId: 'a1' }],
            },
            { Agent: ['id', 'userId', 'organizationId'], AgentMembership: ['id', 'agentId'] },
        );
        const collector = new EntityBackupCollector(spec);
        const context = contextFor(source);

        const upFront = await collector.plan(context);
        const memberships = upFront.find((plan) => plan.file === 'memberships.jsonl')!;
        expect(memberships.query.within?.ids).toEqual([]);

        for await (const _row of collector.rows(
            context,
            upFront.find((p) => p.file === 'agents.jsonl')!,
        )) {
            void _row;
        }

        const walked = await collector.replan(context, memberships);
        expect(walked.file).toBe('memberships.jsonl');
        expect(walked.query.within).toEqual({ column: 'agentId', ids: ['a1'] });
        const rows: Record<string, unknown>[] = [];
        for await (const row of collector.rows(context, walked)) rows.push(row);
        expect(rows.map((row) => row.id)).toEqual(['m1']);
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

describe('a workspace with no organization, on organization-scoped tables', () => {
    // A person who has not created an organization yet is the DEFAULT state:
    // tenants are created lazily, and the scope-stamping subscriber writes
    // `organizationId = NULL` onto every row they make. Their webhook
    // subscriptions, code-host installations, onboarding requests and email
    // conversations all sit there. The cross-account fix planned all four
    // files as "matches nothing", so the owner's OWN rows vanished from the
    // archive — and the domain still said `complete` or `empty`.
    const PERSONAL = { userId: 'u1', organizationId: null, tenantId: 't1' };
    const connections = BACKUP_DOMAIN_SPECS.find((candidate) => candidate.key === 'connections')!;

    function registry() {
        const registrations = new Map<string, { ids: readonly string[]; complete: boolean }>();
        return {
            registrations,
            overrides: {
                registerIds: (name: string, ids: readonly string[], complete = true) =>
                    registrations.set(name, { ids, complete }),
                idsFor: (name: string) => registrations.get(name)?.ids ?? [],
                idsComplete: (name: string) => registrations.get(name)?.complete ?? true,
            },
        };
    }

    it('narrows the owner’s webhook subscriptions by their owner column, not by nothing', async () => {
        const source = new FixtureRowSource(
            { WebhookSubscription: [] },
            { WebhookSubscription: ['id', 'accountId', 'organizationId'] },
        );
        const plans = await new EntityBackupCollector(connections).plan(
            contextFor(source, { scope: PERSONAL }),
        );
        const subscriptions = plans.find((plan) => plan.spec.entity === 'WebhookSubscription')!;

        expect(subscriptions.query.matchesNothing).toBeUndefined();
        expect(subscriptions.query.equals).toEqual({ accountId: 'u1', organizationId: null });
        expect(subscriptions.errorCode).toBeUndefined();
    });

    it('exports the owner’s own subscription rows and registers their ids as whole', async () => {
        const source = new FixtureRowSource(
            {
                WebhookSubscription: [{ id: 'wh-own', accountId: 'u1', organizationId: null }],
            },
            { WebhookSubscription: ['id', 'accountId', 'organizationId'] },
        );
        const { registrations, overrides } = registry();
        const context = contextFor(source, { scope: PERSONAL, ...overrides });
        const collector = new EntityBackupCollector(connections);
        const subscriptions = (await collector.plan(context)).find(
            (plan) => plan.spec.entity === 'WebhookSubscription',
        )!;

        const rows: Record<string, unknown>[] = [];
        for await (const row of collector.rows(context, subscriptions)) rows.push(row);

        expect(rows.map((row) => row.id)).toEqual(['wh-own']);
        expect(registrations.get('webhookIds')).toEqual({ ids: ['wh-own'], complete: true });
    });

    it('reaches the owner’s email conversations through their own agents', async () => {
        const communication = BACKUP_DOMAIN_SPECS.find(
            (candidate) => candidate.key === 'communication',
        )!;
        const source = new FixtureRowSource(
            { EmailConversation: [] },
            { EmailConversation: ['id', 'agentId', 'organizationId'] },
        );
        const { overrides } = registry();
        const context = contextFor(source, { scope: PERSONAL, ...overrides });
        context.registerIds('agentIds', ['agent-own']);

        const conversations = (await new EntityBackupCollector(communication).plan(context)).find(
            (plan) => plan.spec.entity === 'EmailConversation',
        )!;

        expect(conversations.query.matchesNothing).toBeUndefined();
        expect(conversations.query.within).toEqual({ column: 'agentId', ids: ['agent-own'] });
    });

    it('reports a gap, not an absence, for a nullable table it cannot narrow', async () => {
        // An `organization` file with no personal rule over a column that
        // CAN be NULL: the owner's rows may exist and were not read.
        const spec = {
            key: 'connections' as const,
            files: [
                {
                    file: 'subscriptions.jsonl',
                    entity: 'WebhookSubscription',
                    scope: { by: 'organization' as const },
                },
            ],
        };
        const source: BackupRowSource = {
            hasEntity: () => true,
            hasColumn: () => true,
            isNullable: () => true,
            page: async () => [],
            countTrimmed: async () => 0,
        };
        const [plan] = await new EntityBackupCollector(spec).plan(
            contextFor(source, { scope: PERSONAL }),
        );

        expect(plan.query.matchesNothing).toBe(true);
        expect(plan.errorCode).toBe('scope_unresolved');
    });

    it('treats a source that cannot say whether the column is nullable as a gap', async () => {
        const spec = {
            key: 'connections' as const,
            files: [
                {
                    file: 'subscriptions.jsonl',
                    entity: 'WebhookSubscription',
                    scope: { by: 'organization' as const },
                },
            ],
        };
        const source = new FixtureRowSource(
            { WebhookSubscription: [] },
            { WebhookSubscription: ['id', 'organizationId'] },
        );
        const [plan] = await new EntityBackupCollector(spec).plan(
            contextFor(source, { scope: PERSONAL }),
        );

        expect(plan.errorCode).toBe('scope_unresolved');
    });

    it('reports a table whose organizationId cannot be NULL as honestly empty', async () => {
        // An organization's members cannot belong to a workspace with no
        // organization, so "you have none of these" is simply true there.
        const organizations = BACKUP_DOMAIN_SPECS.find(
            (candidate) => candidate.key === 'organizations',
        )!;
        const source: BackupRowSource = {
            hasEntity: () => true,
            hasColumn: () => true,
            isNullable: () => false,
            page: async () => {
                throw new Error('an unscopable file must not be queried');
            },
            countTrimmed: async () => 0,
        };
        const members = (
            await new EntityBackupCollector(organizations).plan(
                contextFor(source, { scope: PERSONAL }),
            )
        ).find((plan) => plan.spec.entity === 'OrganizationMember')!;

        expect(members.query.matchesNothing).toBe(true);
        expect(members.errorCode).toBeUndefined();
    });

    it('registers a skipped parent as incomplete, so its children report the gap', async () => {
        // The early returns used to sit before registration, so a skipped
        // `webhook-subscriptions.jsonl` left `webhookIds` unregistered, an
        // unregistered name read as complete, and `webhook-deliveries.jsonl`
        // wrote nothing with no error behind it.
        const spec = {
            key: 'connections' as const,
            files: [
                {
                    file: 'subscriptions.jsonl',
                    entity: 'WebhookSubscription',
                    scope: { by: 'organization' as const },
                    registerIdsAs: 'webhookIds',
                },
                {
                    file: 'deliveries.jsonl',
                    entity: 'WebhookDelivery',
                    scope: { by: 'parent' as const, column: 'subscriptionId', from: 'webhookIds' },
                },
            ],
        };
        const source: BackupRowSource = {
            hasEntity: () => true,
            hasColumn: () => true,
            isNullable: () => true,
            page: async () => [],
            countTrimmed: async () => 0,
        };
        const { registrations, overrides } = registry();
        const context = contextFor(source, { scope: PERSONAL, ...overrides });
        const collector = new EntityBackupCollector(spec);

        const [subscriptions] = await collector.plan(context);
        for await (const _row of collector.rows(context, subscriptions)) void _row;

        expect(registrations.get('webhookIds')).toEqual({ ids: [], complete: false });
        const deliveries = (await collector.plan(context))[1];
        expect(deliveries.errorCode).toBe('parent_ids_incomplete');
    });

    it('registers an honestly empty parent as complete', async () => {
        const spec = {
            key: 'organizations' as const,
            files: [
                {
                    file: 'members.jsonl',
                    entity: 'OrganizationMember',
                    scope: { by: 'organization' as const },
                    registerIdsAs: 'memberIds',
                },
            ],
        };
        const source: BackupRowSource = {
            hasEntity: () => true,
            hasColumn: () => true,
            isNullable: () => false,
            page: async () => [],
            countTrimmed: async () => 0,
        };
        const { registrations, overrides } = registry();
        const context = contextFor(source, { scope: PERSONAL, ...overrides });
        const collector = new EntityBackupCollector(spec);

        const [members] = await collector.plan(context);
        for await (const _row of collector.rows(context, members)) void _row;

        expect(registrations.get('memberIds')).toEqual({ ids: [], complete: true });
    });

    it('registers a parent this build does not carry as incomplete', async () => {
        const { registrations, overrides } = registry();
        const context = contextFor(new FixtureRowSource({}), overrides);
        const collector = new EntityBackupCollector(connections);

        const subscriptions = (await collector.plan(context)).find(
            (plan) => plan.spec.entity === 'WebhookSubscription',
        )!;
        expect(subscriptions.unavailable).toBe(true);
        for await (const _row of collector.rows(context, subscriptions)) void _row;

        expect(registrations.get('webhookIds')).toEqual({ ids: [], complete: false });
    });
});

describe('the personal scope rules in the coverage table', () => {
    it('names only columns the entity actually declares', () => {
        const problems: string[] = [];
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                const rule = file.personalScope;
                if (!rule) continue;
                const columns = columnsOf(file.entity);
                if (columns.size === 0) continue;
                const required =
                    rule.by === 'workspace'
                        ? [rule.userColumn ?? 'userId', 'organizationId']
                        : rule.by === 'parent'
                          ? [rule.column]
                          : rule.by === 'user'
                            ? ['userId']
                            : ['organizationId'];
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
        const registered = new Set<string>();
        const problems: string[] = [];
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                const rule = file.personalScope;
                if (rule?.by === 'parent' && !registered.has(rule.from)) {
                    problems.push(`${spec.key}/${file.file} wants ${rule.from}`);
                }
                if (file.registerIdsAs) registered.add(file.registerIdsAs);
            }
        }
        expect(problems).toEqual([]);
    });

    it('never falls back to organization scoping, which is what it exists to replace', () => {
        for (const spec of BACKUP_DOMAIN_SPECS) {
            for (const file of spec.files) {
                if (!file.personalScope) continue;
                expect(file.personalScope.by).not.toBe('organization');
                expect(file.personalScope.by).not.toBe('owner');
            }
        }
    });

    it('covers the four nullable organization tables that hold an owner’s rows', () => {
        const personal = BACKUP_DOMAIN_SPECS.flatMap((spec) =>
            spec.files.filter((file) => file.personalScope).map((file) => file.entity),
        );
        expect(personal.sort()).toEqual([
            'EmailConversation',
            'GitHubAppInstallation',
            'OnboardingRequest',
            'WebhookSubscription',
        ]);
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

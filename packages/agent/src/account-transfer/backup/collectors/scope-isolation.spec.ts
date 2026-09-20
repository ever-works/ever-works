import { BACKUP_DOMAINS } from '@ever-works/contracts';
import { BACKUP_COLLECTORS } from './index';
import { BACKUP_DOMAIN_SPECS } from './domain-specs';
import type {
    BackupCollectContext,
    BackupEntityQuery,
    BackupFilePlan,
    BackupRowSource,
    BackupScope,
} from './collector.types';

/**
 * Workspace backup (AW-22) — the one property the whole design exists to
 * protect: a workspace's archive contains that workspace's rows and nobody
 * else's.
 *
 * This spec is driven off {@link BACKUP_DOMAINS} and
 * {@link BACKUP_DOMAIN_SPECS} rather than a hand-picked sample, because the
 * failure it guards against is exactly the file nobody thought to sample.
 * Every file of every domain is planned under both workspace shapes — an
 * organization workspace, and a personal one with no organization — and each
 * resulting query has to be narrowed by something that names THIS workspace.
 *
 * ## What was wrong, and why a structural assertion is the right shape
 *
 * The `organization` scope rule narrowed on `organizationId` alone. Asked
 * for a personal workspace it produced `organizationId IS NULL`, which is
 * not "this workspace's rows" — it is "every row in the table that no
 * organization owns". Four of the eight tables that rule covers declare
 * `organizationId` nullable and document NULL as the state every row sits in
 * until its owner creates their first organization, so the archive carried
 * every other account's onboarding contact emails, conversation
 * participants, code-host installation payloads and webhook URLs.
 *
 * A fixture test over one sampled entity would not have caught it: the one
 * un-organized case the suite had used a `workspace`-scoped table, which
 * carries `userId` too and was genuinely safe. So the assertion here is a
 * property of the PLAN — every query is narrowed by an identity of this
 * workspace, or it matches nothing at all — checked for all of them.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const PARENT_ID = '44444444-4444-4444-8444-444444444444';

const ORGANIZATION_WORKSPACE: BackupScope = {
    userId: USER,
    organizationId: ORG,
    tenantId: TENANT,
};
const PERSONAL_WORKSPACE: BackupScope = { userId: USER, organizationId: null, tenantId: TENANT };

/**
 * Values that identify THIS workspace. A query narrowed by one of these
 * cannot reach another account; a query narrowed by anything else has to
 * justify itself.
 */
function workspaceIdentities(scope: BackupScope): string[] {
    return [scope.userId, ...(scope.organizationId ? [scope.organizationId] : [])];
}

/**
 * A source that claims to know every entity and every column, so planning is
 * exercised at its widest: `hasColumn` returning true is what makes the
 * `workspace` rule add its `organizationId` clause, and `hasEntity`
 * returning true is what stops a plan being marked `unavailable` and
 * skipping the assertion.
 */
const OMNISCIENT_SOURCE: BackupRowSource = {
    hasEntity: () => true,
    hasColumn: () => true,
    page: async () => [],
    countTrimmed: async () => 0,
};

function contextFor(scope: BackupScope): BackupCollectContext {
    const ids = new Map<string, readonly string[]>();
    return {
        scope,
        includeFullHistory: false,
        now: new Date('2026-09-17T00:00:00.000Z'),
        source: OMNISCIENT_SOURCE,
        pageSize: 500,
        enqueueFile: () => undefined,
        registerIds: (name, value) => ids.set(name, value),
        // A `parent` file is scoped by the ids its parent registered. Those
        // ids come from a query that was itself narrowed, so what matters
        // here is that the child asks for an `IN (...)` at all rather than
        // falling back to an unnarrowed predicate.
        idsFor: () => [PARENT_ID],
        shouldStop: () => false,
        heartbeat: async () => undefined,
    };
}

/** Every file of every domain, planned for one workspace shape. */
async function planEverything(
    scope: BackupScope,
): Promise<Array<{ domain: string; plan: BackupFilePlan }>> {
    const context = contextFor(scope);
    const planned: Array<{ domain: string; plan: BackupFilePlan }> = [];
    for (const domain of BACKUP_DOMAINS) {
        const collector = BACKUP_COLLECTORS.get(domain.key);
        expect(collector).toBeDefined();
        for (const plan of await collector!.plan(context)) {
            planned.push({ domain: domain.key, plan });
        }
    }
    return planned;
}

/**
 * Why this query cannot reach another workspace, or `null` when nothing
 * about it says so.
 */
function narrowedBy(query: BackupEntityQuery, scope: BackupScope): string | null {
    if (query.matchesNothing) {
        return 'matches nothing';
    }
    if (query.within) {
        return `within ${query.within.column}`;
    }
    const identities = workspaceIdentities(scope);
    for (const [column, value] of Object.entries(query.equals)) {
        if (typeof value === 'string' && value !== '' && identities.includes(value)) {
            return `${column} = a workspace identity`;
        }
    }
    return null;
}

describe('workspace backup scope isolation', () => {
    it('covers every domain the format publishes (a shrinking sweep is a silent gap)', async () => {
        const planned = await planEverything(ORGANIZATION_WORKSPACE);
        const files = BACKUP_DOMAIN_SPECS.reduce((sum, spec) => sum + spec.files.length, 0);

        expect(planned).toHaveLength(files);
        expect(new Set(planned.map((entry) => entry.domain)).size).toBe(BACKUP_DOMAINS.length);
        expect(files).toBeGreaterThan(100);
    });

    it.each([
        ['an organization workspace', ORGANIZATION_WORKSPACE],
        ['a personal workspace', PERSONAL_WORKSPACE],
    ])('narrows every file of every domain to %s', async (_label, scope) => {
        const unnarrowed = (await planEverything(scope))
            .filter(({ plan }) => !plan.unavailable)
            .filter(({ plan }) => narrowedBy(plan.query, scope) === null)
            .map(({ domain, plan }) => `${domain}/${plan.file} (${plan.spec.entity})`);

        // If this fails, a scope rule produced a predicate that does not
        // name this workspace. Every row it returns lands in an archive
        // somebody downloads, so the file must either be narrowed by a
        // workspace identity or planned as matching nothing.
        expect(unnarrowed).toEqual([]);
    });

    it('never asks for a bare IS NULL as a whole predicate', async () => {
        // The specific shape that leaked: one `equals` entry whose value is
        // null. It looked narrowed — one clause — and narrowed nothing.
        const bare: string[] = [];
        for (const scope of [ORGANIZATION_WORKSPACE, PERSONAL_WORKSPACE]) {
            for (const { domain, plan } of await planEverything(scope)) {
                if (plan.unavailable || plan.query.matchesNothing || plan.query.within) continue;
                const narrowing = Object.entries(plan.query.equals).filter(
                    ([, value]) => value !== null && value !== '',
                );
                if (narrowing.length === 0) {
                    bare.push(`${domain}/${plan.file} (${plan.spec.entity})`);
                }
            }
        }
        expect(bare).toEqual([]);
    });

    it('plans an organization-scoped file as matching nothing in a personal workspace', async () => {
        const organizationScoped = BACKUP_DOMAIN_SPECS.flatMap((spec) =>
            spec.files
                .filter((file) => file.scope.by === 'organization')
                .map((file) => `${spec.key}/${file.file}`),
        );
        // Eight files today. A zero here would mean the rule stopped being
        // used, not that the risk went away.
        expect(organizationScoped.length).toBeGreaterThanOrEqual(8);

        // The `organization` rule itself still never asks for a bare
        // `organizationId IS NULL`. A file that declares a personal rule is
        // planned by THAT rule instead — covered by the next case — so what
        // is asserted here is every organization-scoped file that does not.
        const planned = await planEverything(PERSONAL_WORKSPACE);
        const withoutPersonalRule = planned.filter(
            ({ plan }) => plan.spec.scope.by === 'organization' && !plan.spec.personalScope,
        );
        expect(withoutPersonalRule.length).toBeGreaterThanOrEqual(4);
        for (const { domain, plan } of withoutPersonalRule) {
            expect({
                file: `${domain}/${plan.file}`,
                matchesNothing: plan.query.matchesNothing === true,
                equals: plan.query.equals,
            }).toEqual({
                file: `${domain}/${plan.file}`,
                matchesNothing: true,
                equals: {},
            });
        }
    });

    it('narrows an organization-scoped file by its owner in a personal workspace when it has one', async () => {
        // The other half of the cross-account fix. Matching nothing kept a
        // stranger's rows out, and ALSO dropped the owner's own: a person
        // with no organization yet — the default state — lost every webhook
        // subscription, code-host installation, onboarding request and email
        // conversation from their archive. Those four tables have an owner
        // column, so they are narrowed by it instead.
        const planned = await planEverything(PERSONAL_WORKSPACE);
        const personal = planned.filter(({ plan }) => plan.spec.personalScope);
        expect(personal.map(({ plan }) => plan.spec.entity).sort()).toEqual([
            'EmailConversation',
            'GitHubAppInstallation',
            'OnboardingRequest',
            'WebhookSubscription',
        ]);

        for (const { domain, plan } of personal) {
            const label = `${domain}/${plan.file}`;
            expect({ label, matchesNothing: plan.query.matchesNothing }).toEqual({
                label,
                matchesNothing: undefined,
            });
            expect({ label, narrowedBy: narrowedBy(plan.query, PERSONAL_WORKSPACE) }).not.toEqual({
                label,
                narrowedBy: null,
            });
            const rule = plan.spec.personalScope!;
            if (rule.by === 'workspace') {
                // The owner AND the un-organized scope — never either alone.
                expect({ label, equals: plan.query.equals }).toEqual({
                    label,
                    equals: { [rule.userColumn ?? 'userId']: USER, organizationId: null },
                });
            } else {
                expect(rule.by).toBe('parent');
                expect(plan.query.within).toBeDefined();
            }
        }
    });

    it('still narrows an organization-scoped file by the organization when there is one', async () => {
        const planned = await planEverything(ORGANIZATION_WORKSPACE);
        const organizationScoped = planned.filter(
            ({ plan }) => plan.spec.scope.by === 'organization',
        );

        expect(organizationScoped.length).toBeGreaterThanOrEqual(8);
        for (const { plan } of organizationScoped) {
            expect(plan.query.matchesNothing).toBeUndefined();
            expect(plan.query.equals).toEqual({ organizationId: ORG });
        }
    });

    it('yields no rows and counts no trim for a file that matches nothing', async () => {
        // The flag has to stop the walk, not merely describe it: a source
        // that would answer with rows must never be asked.
        const source: BackupRowSource = {
            hasEntity: () => true,
            hasColumn: () => true,
            page: async () => {
                throw new Error('a file that matches nothing must not be queried');
            },
            countTrimmed: async () => {
                throw new Error('a file that matches nothing must not be counted');
            },
        };
        const context: BackupCollectContext = { ...contextFor(PERSONAL_WORKSPACE), source };
        // An organization's member list: a file that still matches nothing
        // in a personal workspace. (Webhook subscriptions used to be the
        // example; they are now narrowed by their owner instead.)
        const collector = BACKUP_COLLECTORS.get('organizations');
        expect(collector).toBeDefined();

        const plans = await collector!.plan(context);
        const members = plans.find((plan) => plan.spec.entity === 'OrganizationMember');
        expect(members?.query.matchesNothing).toBe(true);

        const rows: Record<string, unknown>[] = [];
        for await (const row of collector!.rows(context, members!)) {
            rows.push(row);
        }
        expect(rows).toEqual([]);
        await expect(collector!.trims(context, [members!])).resolves.toEqual([]);
    });
});

import { randomUUID } from 'crypto';
import { DataSource, type Repository } from 'typeorm';
import { countSkillsNeedingAttention } from '@ever-works/contracts';
import { ENTITIES } from '../../_entities-inventory';
import { Skill } from '../../../entities/skill.entity';
import { SkillBinding } from '../../../entities/skill-binding.entity';
import { SkillTag } from '../../../entities/skill-tag.entity';
import { SkillRepository } from '../skill.repository';
import { SkillBindingRepository } from '../skill-binding.repository';
import { SkillTagRepository } from '../skill-tag.repository';

/**
 * Skills shelf — the SQL, against a real better-sqlite3 schema built from
 * the full entity inventory (the same driver the e2e stack runs).
 *
 * Pinned here rather than with query-builder mocks because the behaviour
 * that matters is what the database returns: AND semantics across tags,
 * facet ordering and cap, every readiness predicate, the three sorts, tag
 * search, the per-user sweep cap, and — the additive-only proof — that
 * `resolveActive` returns exactly what it returned before for Skills nobody
 * switched off or left in review.
 */
describe('Skills shelf repositories (better-sqlite3)', () => {
    let dataSource: DataSource;
    let skills: SkillRepository;
    let tags: SkillTagRepository;
    let bindings: SkillBindingRepository;
    let skillRepo: Repository<Skill>;
    const USER = randomUUID();
    const OTHER = randomUUID();

    async function makeSkill(
        over: Partial<Skill> & { tags?: string[]; userId?: string } = {},
    ): Promise<Skill> {
        const userId = over.userId ?? USER;
        const { tags: tagList, ...rest } = over;
        const slug = rest.slug ?? `s-${randomUUID().slice(0, 8)}`;
        const row = await skillRepo.save(
            skillRepo.create({
                userId,
                ownerType: 'tenant',
                ownerId: userId,
                slug,
                title: slug,
                description: 'd',
                frontmatter: { name: slug, description: 'd' },
                instructionsMd: 'body',
                contentHash: 'h',
                ...rest,
            }),
        );
        if (tagList) await tags.replaceForSkill(row.id, userId, tagList);
        return row;
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        skillRepo = dataSource.getRepository(Skill);
        skills = new SkillRepository(skillRepo);
        tags = new SkillTagRepository(dataSource.getRepository(SkillTag));
        bindings = new SkillBindingRepository(dataSource.getRepository(SkillBinding));
        // The users table has many unrelated NOT NULL columns; the FK to it is
        // not what these specs are about.
        await dataSource.query('PRAGMA foreign_keys = OFF');
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.query('DELETE FROM skill_tags');
        await dataSource.query('DELETE FROM skill_bindings');
        await dataSource.query('DELETE FROM skills');
    });

    describe('tags', () => {
        it('AND-filters across one, two and three tags', async () => {
            const a = await makeSkill({ slug: 'a', tags: ['billing', 'email', 'sales'] });
            const b = await makeSkill({ slug: 'b', tags: ['billing', 'email'] });
            await makeSkill({ slug: 'c', tags: ['billing'] });
            await makeSkill({ slug: 'd' });

            const ids = async (filterTags: string[]) =>
                (await skills.findByUserIdFiltered(USER, { tags: filterTags })).rows
                    .map((s) => s.slug)
                    .sort();

            expect(await ids(['billing'])).toEqual(['a', 'b', 'c']);
            expect(await ids(['billing', 'email'])).toEqual(['a', 'b']);
            expect(await ids(['billing', 'email', 'sales'])).toEqual(['a']);
            expect(await ids(['billing', 'nope'])).toEqual([]);
            const { total } = await skills.findByUserIdFiltered(USER, {
                tags: ['billing', 'email'],
            });
            expect(total).toBe(2);
            expect([a.id, b.id]).toHaveLength(2);
        });

        it('never matches another user’s tags', async () => {
            await makeSkill({ slug: 'mine', tags: ['billing'] });
            await makeSkill({ slug: 'theirs', userId: OTHER, tags: ['billing'] });
            const { rows } = await skills.findByUserIdFiltered(USER, { tags: ['billing'] });
            expect(rows.map((s) => s.slug)).toEqual(['mine']);
            const facets = await tags.facets(USER);
            expect(facets.tags).toEqual([{ tag: 'billing', count: 1 }]);
        });

        it('orders facets by count desc then alphabetically, and caps them', async () => {
            await makeSkill({ tags: ['zeta', 'alpha'] });
            await makeSkill({ tags: ['zeta', 'beta'] });
            await makeSkill({ tags: ['gamma'] });
            const { tags: facets, total } = await tags.facets(USER);
            expect(facets).toEqual([
                { tag: 'zeta', count: 2 },
                { tag: 'alpha', count: 1 },
                { tag: 'beta', count: 1 },
                { tag: 'gamma', count: 1 },
            ]);
            expect(total).toBe(4);
            const capped = await tags.facets(USER, 2);
            expect(capped.tags.map((f) => f.tag)).toEqual(['zeta', 'alpha']);
            expect(capped.total).toBe(4);
            expect((await tags.facets(USER, 5000)).tags).toHaveLength(4);
        });

        it('replaceForSkill adds, removes and no-ops', async () => {
            const s = await makeSkill({ tags: ['one', 'two'] });
            await tags.replaceForSkill(s.id, USER, ['two', 'three']);
            expect((await tags.findBySkillIds([s.id], USER)).get(s.id)).toEqual(['three', 'two']);
            await tags.replaceForSkill(s.id, USER, []);
            expect((await tags.findBySkillIds([s.id], USER)).get(s.id)).toBeUndefined();
            expect((await tags.findBySkillIds([], USER)).size).toBe(0);
        });

        it('search matches a tag as well as title, slug and description', async () => {
            await makeSkill({ slug: 'refunds', tags: ['payments'] });
            await makeSkill({ slug: 'other', tags: ['billing'] });
            const { rows } = await skills.findByUserIdFiltered(USER, { search: 'PAYMENT' });
            expect(rows.map((s) => s.slug)).toEqual(['refunds']);
            const bySlug = await skills.findByUserIdFiltered(USER, { search: 'other' });
            expect(bySlug.rows.map((s) => s.slug)).toEqual(['other']);
        });
    });

    describe('readiness, enabled and sort', () => {
        async function seedStates() {
            await makeSkill({ slug: 'ready', readiness: 'ready' });
            await makeSkill({ slug: 'setup', readiness: 'needs_setup' });
            await makeSkill({ slug: 'missing', readiness: 'missing_requirements' });
            await makeSkill({ slug: 'off', readiness: 'ready', disabledAt: new Date() });
            await makeSkill({ slug: 'draft', readiness: 'ready', reviewState: 'proposed' });
            await makeSkill({ slug: 'fresh' }); // default unknown
        }

        const slugs = async (filter: Parameters<SkillRepository['findByUserIdFiltered']>[1]) =>
            (await skills.findByUserIdFiltered(USER, filter)).rows.map((s) => s.slug).sort();

        it('defaults a new Skill to unknown, never ready', async () => {
            const s = await makeSkill();
            expect((await skills.findByIdAndUser(s.id, USER))?.readiness).toBe('unknown');
        });

        it('filters by each card state and by attention', async () => {
            await seedStates();
            expect(await slugs({ readiness: 'ready' })).toEqual(['ready']);
            expect(await slugs({ readiness: 'needs_setup' })).toEqual(['setup']);
            expect(await slugs({ readiness: 'disabled' })).toEqual(['off']);
            expect(await slugs({ readiness: 'needs_review' })).toEqual(['draft']);
            expect(await slugs({ readiness: 'unknown' })).toEqual(['fresh']);
            // "Not checked yet" and switched off are selectable on their own, but
            // neither is a problem.
            expect(await slugs({ readiness: 'attention' })).toEqual(['draft', 'missing', 'setup']);
        });

        it('a shelf of Skills nothing has checked yet has nothing needing attention', async () => {
            for (let i = 0; i < 4; i += 1) await makeSkill({ slug: `fresh-${i}` });

            const counts = await skills.countsByCardState(USER);
            expect(counts.unknown).toBe(4);
            expect(countSkillsNeedingAttention(counts)).toBe(0);
            expect(await slugs({ readiness: 'attention' })).toEqual([]);
            // Still reachable through the explicit state filter.
            expect(await slugs({ readiness: 'unknown' })).toHaveLength(4);
        });

        it('counts and selects only real problems as needing attention', async () => {
            await seedStates();
            await makeSkill({ slug: 'failed', readiness: 'check_failed' });
            await makeSkill({ slug: 'blocked', readiness: 'blocked_by_access' });
            await makeSkill({ slug: 'bogus', readiness: 'not-a-state' as never });

            const counts = await skills.countsByCardState(USER);
            const attention = await slugs({ readiness: 'attention' });
            expect(attention).toEqual(['blocked', 'draft', 'failed', 'missing', 'setup']);
            // The summary number and the filter agree, row for row.
            expect(countSkillsNeedingAttention(counts)).toBe(attention.length);
            // An unrecognised stored verdict reads as not-checked-yet, not as a problem.
            expect(counts.unknown).toBe(2);
        });

        it('does not count a Skill switched off on purpose, but the disabled filter still returns it', async () => {
            // Switched off while carrying a real problem, and while in review:
            // the owner's choice wins, so neither needs them.
            await makeSkill({
                slug: 'off-missing',
                readiness: 'missing_requirements',
                disabledAt: new Date(),
            });
            await makeSkill({
                slug: 'off-draft',
                readiness: 'ready',
                reviewState: 'proposed',
                disabledAt: new Date(),
            });
            await makeSkill({ slug: 'setup', readiness: 'needs_setup' });
            await makeSkill({ slug: 'draft', readiness: 'ready', reviewState: 'proposed' });

            const counts = await skills.countsByCardState(USER);
            expect(counts.disabled).toBe(2);
            expect(countSkillsNeedingAttention(counts)).toBe(2);
            expect(await slugs({ readiness: 'attention' })).toEqual(['draft', 'setup']);
            expect(await slugs({ readiness: 'disabled' })).toEqual(['off-draft', 'off-missing']);
            expect(await slugs({ enabled: false })).toEqual(['off-draft', 'off-missing']);

            const byAttention = await skills.findByUserIdFiltered(USER, { sort: 'attention' });
            expect(
                byAttention.rows
                    .slice(-2)
                    .map((s) => s.slug)
                    .sort(),
            ).toEqual(['off-draft', 'off-missing']);
        });

        it('filters by the on/off switch', async () => {
            await seedStates();
            expect(await slugs({ enabled: false })).toEqual(['off']);
            expect(await slugs({ enabled: true })).not.toContain('off');
        });

        it('counts every card state for the summary line', async () => {
            await seedStates();
            await makeSkill({ slug: 'theirs', userId: OTHER, readiness: 'needs_setup' });
            expect(await skills.countsByCardState(USER)).toEqual({
                ready: 1,
                needs_setup: 1,
                missing_requirements: 1,
                blocked_by_access: 0,
                unknown: 1,
                check_failed: 0,
                disabled: 1,
                needs_review: 1,
            });
        });

        it('keeps a check that failed apart from a Skill nothing has checked yet', async () => {
            await makeSkill({ slug: 'fresh' });
            await makeSkill({ slug: 'failed', readiness: 'check_failed' });
            expect(await slugs({ readiness: 'unknown' })).toEqual(['fresh']);
            expect(await slugs({ readiness: 'check_failed' })).toEqual(['failed']);
            expect(await skills.countsByCardState(USER)).toMatchObject({
                unknown: 1,
                check_failed: 1,
            });
        });

        it('sorts by name case-insensitively and by attention first', async () => {
            const t0 = Date.now();
            await makeSkill({
                slug: 'b-ready',
                title: 'banana',
                readiness: 'ready',
                updatedAt: new Date(t0 - 3000),
            });
            await makeSkill({
                slug: 'a-setup',
                title: 'Apple',
                readiness: 'needs_setup',
                updatedAt: new Date(t0 - 2000),
            });
            await makeSkill({
                slug: 'c-ready',
                title: 'cherry',
                readiness: 'ready',
                updatedAt: new Date(t0 - 1000),
            });

            const byName = await skills.findByUserIdFiltered(USER, { sort: 'name' });
            expect(byName.rows.map((s) => s.title)).toEqual(['Apple', 'banana', 'cherry']);
            const byAttention = await skills.findByUserIdFiltered(USER, { sort: 'attention' });
            expect(byAttention.rows[0].slug).toBe('a-setup');
            const byDefault = await skills.findByUserIdFiltered(USER, {});
            expect(byDefault.rows).toHaveLength(3);
        });

        it('sorts not-checked-yet Skills with the ones that need nothing', async () => {
            const t0 = Date.now();
            await makeSkill({ slug: 'fresh', updatedAt: new Date(t0 - 1000) });
            await makeSkill({
                slug: 'failed',
                readiness: 'check_failed',
                updatedAt: new Date(t0 - 3000),
            });
            await makeSkill({ slug: 'ready', readiness: 'ready', updatedAt: new Date(t0 - 2000) });

            const byAttention = await skills.findByUserIdFiltered(USER, { sort: 'attention' });
            expect(byAttention.rows.map((s) => s.slug)).toEqual(['failed', 'fresh', 'ready']);
        });

        it('filters by provenance against caller-supplied provider ids', async () => {
            await makeSkill({ slug: 'authored' });
            await makeSkill({
                slug: 'first',
                sourceCatalogSlug: 'first',
                sourcePath: 'provider-a',
            });
            await makeSkill({ slug: 'pkg', sourceCatalogSlug: 'pkg', sourcePath: 'packages' });
            await makeSkill({
                slug: 'third',
                sourceCatalogSlug: 'third',
                sourcePath: 'provider-b',
            });
            const provenanceSources = {
                firstPartyProviderIds: ['provider-a'],
                packageProviderIds: ['packages'],
            };
            expect(await slugs({ provenance: 'authored', provenanceSources })).toEqual([
                'authored',
            ]);
            expect(await slugs({ provenance: 'firstParty', provenanceSources })).toEqual(['first']);
            expect(await slugs({ provenance: 'package', provenanceSources })).toEqual(['pkg']);
            expect(await slugs({ provenance: 'plugin', provenanceSources })).toEqual(['third']);
            expect(await slugs({ provenance: 'firstParty' })).toEqual([]);
        });
    });

    describe('recordReadiness and the sweep work list', () => {
        it('writes only the three readiness columns and is ownership-scoped', async () => {
            const s = await makeSkill({ title: 'Keep me' });
            // An old timestamp, so any stamp by the update would be visible.
            await dataSource.query(
                `UPDATE skills SET "updatedAt" = '2020-01-01 00:00:00' WHERE id = ?`,
                [s.id],
            );
            const before = await skills.findByIdAndUser(s.id, USER);
            const at = new Date('2026-09-14T10:00:00.000Z');
            const detail = {
                requirements: [],
                boundTargetCount: 0,
                mutedBindingCount: 0,
                evaluatedForAgentIds: [],
                evaluatedAt: at.toISOString(),
            };
            expect(
                await skills.recordReadiness(s.id, OTHER, {
                    readiness: 'ready',
                    readinessDetail: detail,
                    readinessCheckedAt: at,
                }),
            ).toBe(false);
            expect((await skills.findByIdAndUser(s.id, USER))?.readiness).toBe('unknown');

            expect(
                await skills.recordReadiness(s.id, USER, {
                    readiness: 'needs_setup',
                    readinessDetail: detail,
                    readinessCheckedAt: at,
                }),
            ).toBe(true);
            const after = await skills.findByIdAndUser(s.id, USER);
            expect(after?.readiness).toBe('needs_setup');
            expect(after?.readinessDetail).toEqual(detail);
            expect(after?.readinessCheckedAt?.toISOString()).toBe(at.toISOString());
            expect(after?.title).toBe('Keep me');
            expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
        });

        it('lists never-checked and stale Skills, capped per user and per batch', async () => {
            const now = Date.now();
            for (let i = 0; i < 4; i += 1) await makeSkill({ slug: `mine-${i}` });
            await makeSkill({ slug: 'theirs', userId: OTHER });
            await makeSkill({ slug: 'fresh', readinessCheckedAt: new Date(now) });
            await makeSkill({ slug: 'stale', readinessCheckedAt: new Date(now - 2 * 3_600_000) });

            const cutoff = new Date(now - 3_600_000);
            const all = await skills.findStaleForReadiness(cutoff, 500, 200);
            expect(all.map((s) => s.slug).sort()).toEqual([
                'mine-0',
                'mine-1',
                'mine-2',
                'mine-3',
                'stale',
                'theirs',
            ]);
            const perUser = await skills.findStaleForReadiness(cutoff, 500, 2);
            expect(perUser.filter((s) => s.userId === USER)).toHaveLength(2);
            expect(perUser.filter((s) => s.userId === OTHER)).toHaveLength(1);
            expect(await skills.findStaleForReadiness(cutoff, 3, 200)).toHaveLength(3);
        });

        it('one owner’s large, older backlog never pushes another owner out of the tick', async () => {
            const now = Date.now();
            // Owner A: 20 never-checked Skills, all older than owner B's one —
            // enough to fill any "oldest N rows" window on its own.
            for (let i = 0; i < 20; i += 1) {
                await makeSkill({
                    slug: `a-${i}`,
                    createdAt: new Date(now - 100_000 + i),
                });
            }
            await makeSkill({ slug: 'b-0', userId: OTHER, createdAt: new Date(now - 1_000) });

            const batch = await skills.findStaleForReadiness(new Date(now - 3_600_000), 4, 2);
            expect(batch.filter((s) => s.userId === OTHER).map((s) => s.slug)).toEqual(['b-0']);
            // Owner A still gets its per-user share, and its OLDEST Skills.
            expect(batch.filter((s) => s.userId === USER).map((s) => s.slug)).toEqual([
                'a-0',
                'a-1',
            ]);
            expect(batch).toHaveLength(3);
        });

        it('stale owners are not starved either, and never-checked Skills still go first', async () => {
            const now = Date.now();
            const cutoff = new Date(now - 3_600_000);
            for (let i = 0; i < 10; i += 1) {
                await makeSkill({
                    slug: `a-stale-${i}`,
                    readinessCheckedAt: new Date(now - 90_000_000 + i),
                });
            }
            await makeSkill({
                slug: 'b-stale',
                userId: OTHER,
                readinessCheckedAt: new Date(now - 7_200_000),
            });
            await makeSkill({ slug: 'b-fresh-never', userId: OTHER });

            const batch = await skills.findStaleForReadiness(cutoff, 3, 10);
            expect(batch.map((s) => s.slug)).toEqual(['b-fresh-never', 'a-stale-0', 'b-stale']);
        });

        it('fills the batch across owners as evenly as their backlogs allow, never past a cap', async () => {
            const now = Date.now();
            const THIRD = randomUUID();
            for (let i = 0; i < 6; i += 1) {
                await makeSkill({ slug: `a-${i}`, createdAt: new Date(now - 60_000 + i) });
            }
            await makeSkill({ slug: 'b-0', userId: OTHER, createdAt: new Date(now - 50_000) });
            for (let i = 0; i < 6; i += 1) {
                await makeSkill({
                    slug: `c-${i}`,
                    userId: THIRD,
                    createdAt: new Date(now - 40_000 + i),
                });
            }
            const cutoff = new Date(now - 3_600_000);

            const batch = await skills.findStaleForReadiness(cutoff, 7, 5);
            const per = (userId: string) => batch.filter((s) => s.userId === userId).length;
            expect(batch).toHaveLength(7);
            expect([per(USER), per(OTHER), per(THIRD)]).toEqual([3, 1, 3]);
            // Everyone gets one before anyone gets a second.
            expect(batch.slice(0, 3).map((s) => s.slug)).toEqual(['a-0', 'b-0', 'c-0']);

            const capped = await skills.findStaleForReadiness(cutoff, 500, 2);
            expect([
                capped.filter((s) => s.userId === USER).length,
                capped.filter((s) => s.userId === OTHER).length,
                capped.filter((s) => s.userId === THIRD).length,
            ]).toEqual([2, 1, 2]);
            expect(await skills.findStaleForReadiness(cutoff, 0, 5)).toEqual([]);
        });
    });

    describe('workspace scope — another workspace’s Skill is not on this shelf', () => {
        const TENANT = randomUUID();
        const ORG_A = randomUUID();
        const ORG_B = randomUUID();
        const inA = { tenantId: TENANT, organizationId: ORG_A };
        const inB = { tenantId: TENANT, organizationId: ORG_B };
        const personal = { tenantId: TENANT, organizationId: null };

        async function seed() {
            const a = await makeSkill({
                slug: 'in-a',
                tags: ['billing'],
                readiness: 'needs_setup',
                ...inA,
            });
            const b = await makeSkill({
                slug: 'in-b',
                tags: ['billing', 'secret-b'],
                readiness: 'missing_requirements',
                ...inB,
            });
            const mine = await makeSkill({ slug: 'personal', tags: ['notes'], ...personal });
            // Tag rows carry no stamp here on purpose: the scope comes from the Skill row.
            return { a, b, mine };
        }

        it('lists, counts and facets only the active workspace', async () => {
            await seed();
            const listed = await skills.findByUserIdFiltered(USER, {}, inA);
            expect(listed.rows.map((s) => s.slug)).toEqual(['in-a']);
            expect(listed.total).toBe(1);
            expect(
                (await skills.findByUserIdFiltered(USER, { tags: ['billing'] }, inA)).rows.map(
                    (s) => s.slug,
                ),
            ).toEqual(['in-a']);

            const counts = await skills.countsByCardState(USER, {}, inA);
            expect(counts.needs_setup).toBe(1);
            expect(counts.missing_requirements).toBe(0);

            expect(await tags.facets(USER, 200, inA)).toEqual({
                tags: [{ tag: 'billing', count: 1 }],
                total: 1,
            });
            expect((await tags.facets(USER, 200, personal)).tags).toEqual([
                { tag: 'notes', count: 1 },
            ]);
            expect(
                (await skills.findByUserIdFiltered(USER, {}, personal)).rows.map((s) => s.slug),
            ).toEqual(['personal']);
        });

        it('an id lookup in the wrong workspace finds nothing', async () => {
            const { b } = await seed();
            expect(await skills.findByIdAndUser(b.id, USER, inA)).toBeNull();
            expect(await skills.findByIdAndUser(b.id, USER, personal)).toBeNull();
            expect((await skills.findByIdAndUser(b.id, USER, inB))?.slug).toBe('in-b');
        });

        it('without a scope, every lookup answers exactly as before', async () => {
            const { b } = await seed();
            expect((await skills.findByUserIdFiltered(USER, {})).total).toBe(3);
            expect((await skills.findByIdAndUser(b.id, USER))?.slug).toBe('in-b');
            expect((await tags.facets(USER)).total).toBe(3);
            expect(countSkillsNeedingAttention(await skills.countsByCardState(USER))).toBe(2);
        });
    });

    describe('resolveActive — the off switch and the review gate', () => {
        async function bind(skill: Skill, over: Partial<SkillBinding> = {}) {
            await bindings.create({
                skillId: skill.id,
                userId: USER,
                targetType: 'tenant',
                targetId: null,
                priority: 100,
                injectIntoAgent: true,
                injectIntoGenerator: false,
                ...over,
            });
        }

        it('excludes a switched-off Skill and a proposed Skill, and narrows nothing else', async () => {
            const kept1 = await makeSkill({ slug: 'kept-1', readiness: 'missing_requirements' });
            const kept2 = await makeSkill({ slug: 'kept-2' });
            const off = await makeSkill({ slug: 'off' });
            const draft = await makeSkill({ slug: 'draft' });
            await bind(kept1, { priority: 10 });
            await bind(kept2, { priority: 20 });
            await bind(off, { priority: 5 });
            await bind(draft, { priority: 1 });

            // Golden set before anything is switched: every bound Skill, by priority.
            const golden = (await bindings.resolveActive({ userId: USER })).map((row) => ({
                skill: row.skill.slug,
                binding: row.binding.id,
                priority: row.binding.priority,
            }));
            expect(golden.map((row) => row.skill)).toEqual(['draft', 'off', 'kept-1', 'kept-2']);

            await skills.updateByIdAndUser(off.id, USER, { disabledAt: new Date() });
            await skills.updateByIdAndUser(draft.id, USER, { reviewState: 'proposed' });

            const after = (await bindings.resolveActive({ userId: USER })).map((row) => ({
                skill: row.skill.slug,
                binding: row.binding.id,
                priority: row.binding.priority,
            }));
            expect(after).toEqual(golden.filter((row) => row.skill.startsWith('kept')));

            // Switching back on restores exactly the previous result — bindings untouched.
            await skills.updateByIdAndUser(off.id, USER, { disabledAt: null });
            await skills.updateByIdAndUser(draft.id, USER, { reviewState: null });
            const restored = (await bindings.resolveActive({ userId: USER })).map((row) => ({
                skill: row.skill.slug,
                binding: row.binding.id,
                priority: row.binding.priority,
            }));
            expect(restored).toEqual(golden);
        });

        it('counts bindings per Skill in one query, scoped to the owner', async () => {
            const two = await makeSkill({ slug: 'two' });
            const none = await makeSkill({ slug: 'none' });
            await bind(two);
            await bind(two, { targetType: 'agent', targetId: randomUUID() });
            await bindings.create({
                skillId: two.id,
                userId: OTHER,
                targetType: 'tenant',
                targetId: null,
            });
            const counts = await bindings.countBySkillIds([two.id, none.id], USER);
            expect(counts.get(two.id)).toBe(2);
            expect(counts.has(none.id)).toBe(false);
            expect((await bindings.countBySkillIds([], USER)).size).toBe(0);
        });

        it('applies to generator runs too', async () => {
            const off = await makeSkill({ slug: 'off', disabledAt: new Date() });
            await bind(off, { injectIntoGenerator: true });
            expect(
                await bindings.resolveActive({
                    userId: USER,
                    forAgentRun: false,
                    forGeneratorRun: true,
                }),
            ).toEqual([]);
        });
    });
});

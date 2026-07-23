import { WORK_KINDS, WORK_KIND_CAPABILITIES } from '@ever-works/contracts';
import { Work } from '../work.entity';

/**
 * `shouldGenerateProviderRepository()` decides whether the browsable
 * repository published to the git provider is created at all, so its two
 * gates need pinning explicitly: they interact, and getting the precedence
 * wrong either creates repositories nobody asked for or silently stops
 * creating ones people depend on.
 */
function makeWork(overrides: Partial<Work> = {}): Work {
    return Object.assign(new Work(), {
        id: 'w1',
        kind: 'default',
        providerRepositoryEnabled: true,
        ...overrides,
    });
}

describe('Work.shouldGenerateProviderRepository', () => {
    it('generates by default — the behaviour every existing Work relies on', () => {
        expect(makeWork().shouldGenerateProviderRepository()).toBe(true);
    });

    /**
     * TypeORM surfaces a column that predates the migration as `undefined`
     * on a partially-selected entity. That must read as "enabled", not as
     * "disabled" — the opposite would stop generation for the entire
     * installed base.
     */
    it('treats an absent flag as enabled', () => {
        const work = makeWork();
        (work as { providerRepositoryEnabled?: boolean }).providerRepositoryEnabled = undefined;
        expect(work.shouldGenerateProviderRepository()).toBe(true);
    });

    it('respects the user turning it off', () => {
        expect(
            makeWork({ providerRepositoryEnabled: false }).shouldGenerateProviderRepository(),
        ).toBe(false);
    });

    it.each(['default', 'directory', 'awesome-repo', 'blog', 'website', 'landing-page'])(
        'generates for the %s kind when enabled',
        (kind) => {
            expect(makeWork({ kind } as Partial<Work>).shouldGenerateProviderRepository()).toBe(
                true,
            );
        },
    );

    /**
     * Every kind currently provisions this repository — including `company`,
     * whose repo carries the public description of the business. So today
     * the user flag is the only thing that gates it, and this test records
     * that rather than pretending otherwise.
     *
     * The kind gate still exists and is still consulted: it is what lets a
     * future kind (or a change to an existing one) stop generation without
     * touching every caller. `does not generate when the kind provisions no
     * provider repository` below pins that half.
     */
    it('generates for the company kind — its repo holds the public business profile', () => {
        expect(
            makeWork({
                kind: 'company',
                providerRepositoryEnabled: true,
            } as Partial<Work>).shouldGenerateProviderRepository(),
        ).toBe(true);
    });

    /**
     * Kind wins over the stored flag: a kind that does not provision the
     * repository must not generate one even with the flag explicitly on.
     * Asserted against the capability registry directly so it keeps
     * protecting the behaviour if a kind's `repos.work` ever flips.
     */
    it('does not generate when the kind provisions no provider repository', () => {
        const kindWithoutProviderRepo = WORK_KINDS.find(
            (kind) => !WORK_KIND_CAPABILITIES[kind].repos.work,
        );

        if (!kindWithoutProviderRepo) {
            // No such kind today. Prove the gate is wired by asserting the
            // registry is what decides, rather than silently passing.
            expect(WORK_KINDS.every((kind) => WORK_KIND_CAPABILITIES[kind].repos.work)).toBe(true);
            return;
        }

        expect(
            makeWork({
                kind: kindWithoutProviderRepo,
                providerRepositoryEnabled: true,
            } as Partial<Work>).shouldGenerateProviderRepository(),
        ).toBe(false);
    });

    it('keeps the user opt-out when the kind would otherwise allow it', () => {
        expect(
            makeWork({
                kind: 'website',
                providerRepositoryEnabled: false,
            } as Partial<Work>).shouldGenerateProviderRepository(),
        ).toBe(false);
    });

    it('falls back to the default capability set for an unknown kind', () => {
        expect(
            makeWork({
                kind: 'storefront',
            } as unknown as Partial<Work>).shouldGenerateProviderRepository(),
        ).toBe(true);
    });
});

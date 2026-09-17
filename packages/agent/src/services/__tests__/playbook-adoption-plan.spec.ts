import type { PlaybookCatalogEntry } from '@ever-works/contracts';
// The built-in catalogue is data owned by its plugin package; the planner has
// to itemise every one of those entries, so the spec reads it from source.
import { BUILTIN_PLAYBOOKS } from '../../../../plugins/everworks-playbooks/src/builtin-catalog';
import { hashAdoptionPlan, planAdoption } from '../playbook-adoption-plan';

const bySlug = (slug: string): PlaybookCatalogEntry => {
    const entry = BUILTIN_PLAYBOOKS.find((e) => e.slug === slug);
    if (!entry) throw new Error(`missing built-in ${slug}`);
    return entry;
};

describe('planAdoption', () => {
    it('itemises the agent, skills, task template, guardrails and schedule in that order', () => {
        const plan = planAdoption(bySlug('weekly-operations-report'));
        expect(plan.items.map((item) => item.type)).toEqual([
            'agent',
            'skills',
            'task_template',
            'guardrails',
            'schedule',
        ]);
        expect(plan.items[0]).toMatchObject({ count: 1, names: ['Ops reporter'] });
        expect(plan.items[1]).toMatchObject({
            count: 2,
            names: ['digest-compilation', 'campaign-reporting'],
        });
        expect(plan.items[2].detail).toEqual({ steps: 4, needApproval: 0 });
        expect(plan.items[4].detail).toEqual({ cadence: '0 7 * * 1', localTime: '07:00' });
        expect(plan.instanceName).toBe('Weekly operations report');
    });

    it('plans an inbound trigger for a trigger-started playbook and no cadence for it', () => {
        const plan = planAdoption(bySlug('release-checklist'));
        expect(plan.items.map((item) => item.type)).toContain('inbound_trigger');
        expect(plan.items.map((item) => item.type)).not.toContain('schedule');
    });

    it('plans nothing for the cadence of a manual playbook', () => {
        const manual: PlaybookCatalogEntry = {
            ...bySlug('weekly-operations-report'),
            trigger: { kind: 'manual', description: 'On demand' },
            provision: { ...bySlug('weekly-operations-report').provision, skillSlugs: [] },
        };
        expect(planAdoption(manual).items.map((item) => item.type)).toEqual([
            'agent',
            'task_template',
            'guardrails',
        ]);
    });

    it('always plans require_approval guardrails, whatever the graduated posture says', () => {
        for (const entry of BUILTIN_PLAYBOOKS) {
            const guardrails = planAdoption(entry).items.find((item) => item.type === 'guardrails');
            expect(guardrails?.detail.mode).toBe('require_approval');
        }
    });

    it('itemises every built-in playbook with one agent and one task template', () => {
        for (const entry of BUILTIN_PLAYBOOKS) {
            const plan = planAdoption(entry);
            const created = plan.items.reduce((sum, item) => sum + item.count, 0);
            // agent + task template + one row per skill + the cadence (if any)
            const cadence =
                entry.trigger.kind === 'schedule' || entry.trigger.kind === 'inbound_trigger'
                    ? 1
                    : 0;
            expect(created).toBe(2 + entry.provision.skillSlugs.length + cadence);
            expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it('applies the chosen instance name, agent name and run time', () => {
        const plan = planAdoption(bySlug('weekly-operations-report'), {
            instanceName: '  Friday report ',
            agentName: 'Ops reporter 2',
            localTime: '16:30',
        });
        expect(plan.instanceName).toBe('Friday report');
        expect(plan.items[0].names).toEqual(['Ops reporter 2']);
        expect(plan.items.find((item) => item.type === 'schedule')?.detail.localTime).toBe('16:30');
    });

    it('hashes equal plans equally and changes the hash when the version changes', () => {
        const entry = bySlug('market-watch-brief');
        expect(planAdoption(entry).planHash).toBe(planAdoption(entry).planHash);
        const bumped = planAdoption({ ...entry, version: '1.0.1' });
        expect(bumped.planHash).not.toBe(planAdoption(entry).planHash);
        expect(planAdoption(entry, { instanceName: 'Other' }).planHash).not.toBe(
            planAdoption(entry).planHash,
        );
    });

    it('recomputes the same hash from the plan itself', () => {
        const plan = planAdoption(bySlug('daily-decision-brief'));
        expect(hashAdoptionPlan(plan)).toBe(plan.planHash);
    });
});

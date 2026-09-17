// The built-in Playbook catalogue is data owned by its plugin package, which
// cannot depend on this package. The references it makes INTO this package —
// Agent template slugs and the guardrail posture — are pinned from here.
import { BUILTIN_PLAYBOOKS } from '../../../../plugins/everworks-playbooks/src/builtin-catalog';
import { getAgentTemplate } from '../agent-templates';
import { validateGuardrails, type AgentGuardrails } from '../guardrails';

describe('built-in Playbook catalogue ↔ agent package', () => {
    it.each(BUILTIN_PLAYBOOKS.map((entry) => [entry.slug, entry] as const))(
        '%s provisions from a built-in Agent template',
        (_slug, entry) => {
            expect(getAgentTemplate(entry.provision.agentTemplateSlug)).toBeDefined();
            for (const step of entry.steps) {
                if (step.agentTemplateSlug) {
                    expect(getAgentTemplate(step.agentTemplateSlug)).toBeDefined();
                }
            }
        },
    );

    it.each(BUILTIN_PLAYBOOKS.map((entry) => [entry.slug, entry] as const))(
        '%s declares guardrails the platform accepts',
        (_slug, entry) => {
            const postures = [
                entry.provision.guardrailsAtAdoption,
                entry.provision.graduatedGuardrails,
            ].filter(Boolean) as unknown as AgentGuardrails[];
            expect(postures.length).toBeGreaterThan(0);
            for (const posture of postures) {
                expect(validateGuardrails(posture)).toBeNull();
            }
        },
    );
});

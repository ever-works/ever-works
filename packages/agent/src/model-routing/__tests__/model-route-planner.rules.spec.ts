import { decideModelSelection, type ModelSelectionInput } from '../model-route-planner.rules';
import { isCredentialRejection } from '../model-routing.signals';
import { toModelPolicySchedule } from '../model-policy.resolver';

const none = { value: null, source: 'default' as const };

function input(overrides: Partial<ModelSelectionInput>): ModelSelectionInput {
    return { agent: null, primary: none, hasComplexity: false, ...overrides };
}

describe('decideModelSelection', () => {
    it('never re-routes a call that is not made for an Agent', () => {
        expect(
            decideModelSelection(
                input({
                    primary: {
                        value: { providerPluginId: 'provider-b', modelId: 'fast' },
                        source: 'workspace',
                    },
                }),
            ),
        ).toEqual({ source: 'request' });
    });

    it('keeps a provider or model the call named itself', () => {
        const decision = decideModelSelection(
            input({
                agent: { aiProviderId: null, modelId: null },
                requestedModelId: 'call-site-model',
                primary: {
                    value: { providerPluginId: 'provider-b', modelId: 'cheap' },
                    source: 'schedule',
                },
            }),
        );
        expect(decision).toEqual({ source: 'request' });
    });

    it("lets a schedule's model replace the Agent's own pair the call passed", () => {
        const decision = decideModelSelection(
            input({
                agent: { aiProviderId: 'provider-a', modelId: 'big' },
                requestedProviderId: 'provider-a',
                requestedModelId: 'big',
                primary: {
                    value: { providerPluginId: 'provider-b', modelId: 'cheap' },
                    source: 'schedule',
                },
            }),
        );
        expect(decision).toEqual({
            providerPluginId: 'provider-b',
            modelId: 'cheap',
            source: 'schedule',
        });
    });

    it("uses the Agent's own pair unchanged", () => {
        const decision = decideModelSelection(
            input({
                agent: { aiProviderId: 'provider-a', modelId: 'big' },
                requestedProviderId: 'provider-a',
                requestedModelId: 'big',
                primary: {
                    value: { providerPluginId: 'provider-a', modelId: 'big' },
                    source: 'agent',
                },
            }),
        );
        expect(decision).toEqual({ source: 'agent' });
    });

    it('applies the workspace default to an Agent with no pair of its own', () => {
        const decision = decideModelSelection(
            input({
                agent: { aiProviderId: null, modelId: null },
                primary: {
                    value: { providerPluginId: 'provider-b', modelId: 'big' },
                    source: 'workspace',
                },
            }),
        );
        expect(decision).toEqual({
            providerPluginId: 'provider-b',
            modelId: 'big',
            source: 'workspace',
        });
    });

    it('keeps a complexity tier the call asked for — only the provider changes', () => {
        const decision = decideModelSelection(
            input({
                agent: { aiProviderId: null, modelId: null },
                hasComplexity: true,
                primary: {
                    value: { providerPluginId: 'provider-b', modelId: 'big' },
                    source: 'workspace',
                },
            }),
        );
        expect(decision).toEqual({ providerPluginId: 'provider-b', source: 'workspace' });
    });

    it('never lets the workspace default override an Agent that has a pair', () => {
        const decision = decideModelSelection(
            input({
                agent: { aiProviderId: 'provider-a', modelId: null },
                primary: {
                    value: { providerPluginId: 'provider-b', modelId: 'big' },
                    source: 'workspace',
                },
            }),
        );
        expect(decision).toEqual({ source: 'agent' });
    });

    it('changes nothing when nothing is configured', () => {
        expect(
            decideModelSelection(input({ agent: { aiProviderId: null, modelId: null } })),
        ).toEqual({ source: 'default' });
    });
});

describe('isCredentialRejection', () => {
    it('reads 401 and 403 wherever a provider SDK puts the status', () => {
        expect(isCredentialRejection({ status: 401 })).toBe(true);
        expect(isCredentialRejection({ statusCode: '403' })).toBe(true);
        expect(isCredentialRejection({ response: { status: 401 } })).toBe(true);
        expect(
            isCredentialRejection(Object.assign(new Error('wrapped'), { cause: { status: 403 } })),
        ).toBe(true);
    });

    it('does not read a rate limit, a server error, a bad request or a network failure as a rejection', () => {
        expect(isCredentialRejection({ status: 429 })).toBe(false);
        expect(isCredentialRejection({ status: 500 })).toBe(false);
        expect(isCredentialRejection({ status: 400 })).toBe(false);
        expect(isCredentialRejection(new Error('ECONNRESET'))).toBe(false);
        expect(isCredentialRejection(undefined)).toBe(false);
    });
});

describe('toModelPolicySchedule', () => {
    it('accepts only the schedule list vocabulary', () => {
        expect(toModelPolicySchedule('agent_heartbeat:a1')).toEqual({
            source: 'agent_heartbeat',
            ownerId: 'a1',
        });
        expect(toModelPolicySchedule('cron_job:a1')).toBeNull();
        expect(toModelPolicySchedule(null)).toBeNull();
    });
});

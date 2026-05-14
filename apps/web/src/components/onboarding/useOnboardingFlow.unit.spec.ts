import { describe, expect, it } from 'vitest';
import { __test__ } from './useOnboardingFlow';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import type { OnboardingWizardStateV2 } from '@ever-works/contracts/api';

const { reduce, computeStepList, clampToSteps } = __test__;

function defaultsWith(overrides: Partial<OnboardingWizardStateV2>): OnboardingWizardStateV2 {
    return { ...ONBOARDING_DEFAULT_STATE, ...overrides };
}

function initialReducerState() {
    return {
        state: ONBOARDING_DEFAULT_STATE,
        history: [] as number[],
        stepIndex: 0,
        refreshNonce: 0,
    };
}

describe('computeStepList', () => {
    it('returns the minimal 7-step list when every choice is the Ever Works default', () => {
        const list = computeStepList(ONBOARDING_DEFAULT_STATE);
        expect(list.map((s) => s.kind)).toEqual([
            'welcome',
            'ai-choice',
            'storage-choice',
            'deploy-choice',
            'plugins-catalog',
            'create-work',
        ]);
    });

    it('inserts ai-config when the user picks a BYOK AI provider', () => {
        const list = computeStepList(defaultsWith({ ai: { choice: 'openrouter' } }));
        const kinds = list.map((s) => s.kind);
        expect(kinds).toContain('ai-config');
        expect(kinds.indexOf('ai-config')).toBe(kinds.indexOf('ai-choice') + 1);
    });

    it('inserts storage-config only for user-github (the others are Planned/no-config)', () => {
        const github = computeStepList(defaultsWith({ storage: { choice: 'user-github' } }));
        const gitlab = computeStepList(defaultsWith({ storage: { choice: 'user-gitlab' } }));
        const everWorks = computeStepList(ONBOARDING_DEFAULT_STATE);

        expect(github.map((s) => s.kind)).toContain('storage-config');
        expect(gitlab.map((s) => s.kind)).not.toContain('storage-config');
        expect(everWorks.map((s) => s.kind)).not.toContain('storage-config');
    });

    it('inserts deploy-config for vercel and k8s but not for ever-works', () => {
        expect(
            computeStepList(defaultsWith({ deploy: { choice: 'vercel' } })).map((s) => s.kind),
        ).toContain('deploy-config');
        expect(
            computeStepList(defaultsWith({ deploy: { choice: 'k8s' } })).map((s) => s.kind),
        ).toContain('deploy-config');
        expect(computeStepList(ONBOARDING_DEFAULT_STATE).map((s) => s.kind)).not.toContain(
            'deploy-config',
        );
    });

    it('builds the full 9-step list when every BYOK is chosen', () => {
        const list = computeStepList(
            defaultsWith({
                ai: { choice: 'claude-code' },
                storage: { choice: 'user-github' },
                deploy: { choice: 'vercel' },
            }),
        );
        expect(list).toHaveLength(9);
        expect(list.map((s) => s.kind)).toEqual([
            'welcome',
            'ai-choice',
            'ai-config',
            'storage-choice',
            'storage-config',
            'deploy-choice',
            'deploy-config',
            'plugins-catalog',
            'create-work',
        ]);
    });

    it('encodes the chosen vendor into the step id so React keys stay stable across rechooses', () => {
        const list = computeStepList(defaultsWith({ ai: { choice: 'codex' } }));
        const aiConfig = list.find((s) => s.kind === 'ai-config');
        expect(aiConfig?.id).toBe('ai-config:codex');
    });
});

describe('clampToSteps', () => {
    it('clamps below zero up to 0', () => {
        expect(clampToSteps(-2, ONBOARDING_DEFAULT_STATE)).toBe(0);
    });

    it('clamps above the step list to the last index', () => {
        expect(clampToSteps(99, ONBOARDING_DEFAULT_STATE)).toBe(
            computeStepList(ONBOARDING_DEFAULT_STATE).length - 1,
        );
    });

    it('passes valid indices through', () => {
        expect(clampToSteps(2, ONBOARDING_DEFAULT_STATE)).toBe(2);
    });
});

describe('reduce', () => {
    it('goNext advances and pushes the previous index onto history', () => {
        const next = reduce(initialReducerState(), { type: 'goNext' });
        expect(next.stepIndex).toBe(1);
        expect(next.history).toEqual([0]);
        expect(next.state.lastStep).toBe(1);
    });

    it('goNext is a no-op at the last step', () => {
        const total = computeStepList(ONBOARDING_DEFAULT_STATE).length;
        const start = { ...initialReducerState(), stepIndex: total - 1 };
        const next = reduce(start, { type: 'goNext' });
        expect(next).toBe(start);
    });

    it('goBack pops the most recent index from history', () => {
        const after = reduce(reduce(initialReducerState(), { type: 'goNext' }), {
            type: 'goNext',
        });
        const back = reduce(after, { type: 'goBack' });
        expect(back.stepIndex).toBe(1);
        expect(back.history).toEqual([0]);
    });

    it('goBack is a no-op with empty history', () => {
        const start = initialReducerState();
        expect(reduce(start, { type: 'goBack' })).toBe(start);
    });

    it('setAiChoice replaces the AI choice and triggers step-list recomputation downstream', () => {
        const next = reduce(initialReducerState(), { type: 'setAiChoice', value: 'gemini' });
        expect(next.state.ai.choice).toBe('gemini');
        expect(next.state.storage.choice).toBe(ONBOARDING_DEFAULT_STATE.storage.choice);
    });

    it('setStorageChoice replaces the storage choice', () => {
        const next = reduce(initialReducerState(), {
            type: 'setStorageChoice',
            value: 'user-github',
        });
        expect(next.state.storage.choice).toBe('user-github');
    });

    it('setDeployChoice replaces the deploy choice', () => {
        const next = reduce(initialReducerState(), { type: 'setDeployChoice', value: 'k8s' });
        expect(next.state.deploy.choice).toBe('k8s');
    });

    it('recordSkip appends a stepId only once', () => {
        const first = reduce(initialReducerState(), { type: 'recordSkip', stepId: 'ai-config' });
        const dup = reduce(first, { type: 'recordSkip', stepId: 'ai-config' });
        expect(first.state.skippedSteps).toEqual(['ai-config']);
        expect(dup).toBe(first);
    });

    it('setPluginsReviewed flips the flag', () => {
        const next = reduce(initialReducerState(), { type: 'setPluginsReviewed', value: true });
        expect(next.state.pluginsReviewed).toBe(true);
    });

    // EW-617 G4: prompt round-trip through the reducer.
    it('setPrompt stores the trimmed value and clears on whitespace-only input', () => {
        const set = reduce(initialReducerState(), {
            type: 'setPrompt',
            value: '  AI coding assistants directory   ',
        });
        expect(set.state.prompt).toBe('AI coding assistants directory');

        const cleared = reduce(set, { type: 'setPrompt', value: '   ' });
        expect(cleared.state.prompt).toBeUndefined();
    });

    it('mergeServerState replaces state and clamps the current step index', () => {
        const start = { ...initialReducerState(), stepIndex: 8 };
        const next = reduce(start, {
            type: 'mergeServerState',
            value: ONBOARDING_DEFAULT_STATE,
        });
        expect(next.state).toBe(ONBOARDING_DEFAULT_STATE);
        expect(next.stepIndex).toBeLessThanOrEqual(
            computeStepList(ONBOARDING_DEFAULT_STATE).length - 1,
        );
    });

    it('refresh bumps the refreshNonce without touching state', () => {
        const next = reduce(initialReducerState(), { type: 'refresh' });
        expect(next.refreshNonce).toBe(1);
        expect(next.state).toBe(ONBOARDING_DEFAULT_STATE);
    });

    it('jumpTo records history and updates lastStep, clamped to the list', () => {
        const start = initialReducerState();
        const big = reduce(start, { type: 'jumpTo', index: 999 });
        const max = computeStepList(ONBOARDING_DEFAULT_STATE).length - 1;
        expect(big.stepIndex).toBe(max);
        expect(big.state.lastStep).toBe(max);
        expect(big.history).toEqual([0]);
    });
});

jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class {},
}));

import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import { OnboardingStateService, __test__ } from './onboarding-state.service';

interface FakeUser {
    id: string;
    onboardingCompletedAt?: Date | null;
    onboardingDismissedAt?: Date | null;
    onboardingState?: unknown;
}

function buildUserRepository(initial: FakeUser | null) {
    let user: FakeUser | null = initial ? { ...initial } : null;

    return {
        findById: jest.fn(async (id: string) => (user && user.id === id ? user : null)),
        update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
            if (!user || user.id !== id) return null;
            user = { ...user, ...patch };
            return user;
        }),
        _peek: () => user,
    };
}

describe('OnboardingStateService', () => {
    let repo: ReturnType<typeof buildUserRepository>;
    let svc: OnboardingStateService;

    async function makeSvc() {
        const moduleRef = await Test.createTestingModule({
            providers: [OnboardingStateService, { provide: UserRepository, useValue: repo }],
        }).compile();
        svc = moduleRef.get(OnboardingStateService);
    }

    describe('getState', () => {
        it('throws NotFoundException when the user does not exist', async () => {
            repo = buildUserRepository(null);
            await makeSvc();
            await expect(svc.getState('missing')).rejects.toBeInstanceOf(NotFoundException);
        });

        it('returns defaults when the user has no persisted state', async () => {
            repo = buildUserRepository({ id: 'u1' });
            await makeSvc();
            const res = await svc.getState('u1');
            expect(res.completedAt).toBeNull();
            expect(res.dismissedAt).toBeNull();
            expect(res.state).toEqual(ONBOARDING_DEFAULT_STATE);
        });

        it('returns the persisted state and ISO timestamps', async () => {
            const completed = new Date('2026-05-11T20:00:00Z');
            const dismissed = new Date('2026-05-11T19:00:00Z');
            repo = buildUserRepository({
                id: 'u1',
                onboardingCompletedAt: completed,
                onboardingDismissedAt: dismissed,
                onboardingState: {
                    version: 2,
                    lastStep: 4,
                    ai: { choice: 'openrouter' },
                    storage: { choice: 'user-github' },
                    db: { choice: 'ever-works-db' },
                    deploy: { choice: 'vercel' },
                    skippedSteps: ['ai-config'],
                    pluginsReviewed: true,
                },
            });
            await makeSvc();
            const res = await svc.getState('u1');
            expect(res.completedAt).toBe(completed.toISOString());
            expect(res.dismissedAt).toBe(dismissed.toISOString());
            expect(res.state.lastStep).toBe(4);
            expect(res.state.ai.choice).toBe('openrouter');
            expect(res.state.skippedSteps).toEqual(['ai-config']);
            expect(res.state.pluginsReviewed).toBe(true);
        });
    });

    describe('patchState', () => {
        beforeEach(async () => {
            repo = buildUserRepository({ id: 'u1' });
            await makeSvc();
        });

        it('deep-merges patch onto persisted state and persists the result', async () => {
            const first = await svc.patchState('u1', {
                state: { ai: { choice: 'gemini' }, lastStep: 2 },
            });
            expect(first.state.ai.choice).toBe('gemini');
            expect(first.state.lastStep).toBe(2);
            expect(first.state.storage.choice).toBe(ONBOARDING_DEFAULT_STATE.storage.choice);
            expect(repo.update).toHaveBeenCalledTimes(1);

            const second = await svc.patchState('u1', {
                state: { storage: { choice: 'user-github' } },
            });
            expect(second.state.ai.choice).toBe('gemini');
            expect(second.state.storage.choice).toBe('user-github');
            expect(repo.update).toHaveBeenCalledTimes(2);
        });

        it('is idempotent: a no-op patch does not write', async () => {
            await svc.patchState('u1', {
                state: { ai: { choice: 'openrouter' } },
            });
            expect(repo.update).toHaveBeenCalledTimes(1);
            await svc.patchState('u1', {
                state: { ai: { choice: 'openrouter' } },
            });
            expect(repo.update).toHaveBeenCalledTimes(1);
        });

        it('throws NotFoundException for an unknown user', async () => {
            await expect(svc.patchState('other', {})).rejects.toBeInstanceOf(NotFoundException);
        });

        // EW-722 (security wave M, idx 165): `prompt` is contract-declared on
        // `OnboardingStatePatchRequest` and now validated (@MaxLength(5000) in
        // the DTO) AND persisted — previously it was silently dropped.
        it('persists the contract-declared prompt and preserves it across later patches', async () => {
            const first = await svc.patchState('u1', {
                state: { prompt: 'build me a cafe directory' },
            });
            expect(first.state.prompt).toBe('build me a cafe directory');

            // A later patch without `prompt` keeps the persisted value.
            const second = await svc.patchState('u1', {
                state: { lastStep: 3 },
            });
            expect(second.state.prompt).toBe('build me a cafe directory');
            expect(second.state.lastStep).toBe(3);
        });
    });

    describe('markCompleted', () => {
        it('sets onboardingCompletedAt and is idempotent', async () => {
            repo = buildUserRepository({ id: 'u1' });
            await makeSvc();
            const first = await svc.markCompleted('u1');
            expect(first.completedAt).toBeTruthy();
            expect(repo.update).toHaveBeenCalledTimes(1);

            const second = await svc.markCompleted('u1');
            expect(second.completedAt).toBe(first.completedAt);
            expect(repo.update).toHaveBeenCalledTimes(1);
        });
    });

    describe('markDismissed', () => {
        it('sets onboardingDismissedAt and is idempotent', async () => {
            repo = buildUserRepository({ id: 'u1' });
            await makeSvc();
            const first = await svc.markDismissed('u1');
            expect(first.dismissedAt).toBeTruthy();
            expect(repo.update).toHaveBeenCalledTimes(1);

            const second = await svc.markDismissed('u1');
            expect(second.dismissedAt).toBe(first.dismissedAt);
            expect(repo.update).toHaveBeenCalledTimes(1);
        });
    });

    describe('helpers', () => {
        it('normaliseState fills defaults for missing fields', () => {
            const result = __test__.normaliseState({
                version: 2,
                lastStep: -2,
                ai: { choice: 'codex' },
                storage: { choice: undefined as unknown as 'user-github' },
                db: { choice: undefined as unknown as 'ever-works-db' },
                deploy: { choice: undefined as unknown as 'vercel' },
                skippedSteps: undefined as unknown as string[],
                pluginsReviewed: undefined as unknown as boolean,
            });
            expect(result.lastStep).toBe(0);
            expect(result.ai.choice).toBe('codex');
            expect(result.storage.choice).toBe(ONBOARDING_DEFAULT_STATE.storage.choice);
            expect(result.db.choice).toBe(ONBOARDING_DEFAULT_STATE.db.choice);
            expect(result.deploy.choice).toBe(ONBOARDING_DEFAULT_STATE.deploy.choice);
            expect(result.skippedSteps).toEqual([]);
            expect(result.pluginsReviewed).toBe(false);
        });

        it('mergeState keeps current values for missing patch fields', () => {
            const merged = __test__.mergeState(ONBOARDING_DEFAULT_STATE, {
                ai: { choice: 'grok' },
            });
            expect(merged.ai.choice).toBe('grok');
            expect(merged.storage.choice).toBe(ONBOARDING_DEFAULT_STATE.storage.choice);
        });

        // EW-722 (idx 165): prompt round-trips through both helpers; legacy
        // non-string values are dropped rather than persisted.
        it('normaliseState round-trips a string prompt and drops non-string values', () => {
            const withPrompt = __test__.normaliseState({
                ...ONBOARDING_DEFAULT_STATE,
                prompt: 'AI tools directory',
            });
            expect(withPrompt.prompt).toBe('AI tools directory');

            const withBadPrompt = __test__.normaliseState({
                ...ONBOARDING_DEFAULT_STATE,
                prompt: 42 as unknown as string,
            });
            expect(withBadPrompt.prompt).toBeUndefined();
        });

        it('mergeState applies a patched prompt and preserves the current one when omitted', () => {
            const applied = __test__.mergeState(ONBOARDING_DEFAULT_STATE, {
                prompt: 'build me a cafe directory',
            });
            expect(applied.prompt).toBe('build me a cafe directory');

            const preserved = __test__.mergeState(
                { ...ONBOARDING_DEFAULT_STATE, prompt: 'kept' },
                { lastStep: 2 },
            );
            expect(preserved.prompt).toBe('kept');
            expect(preserved.lastStep).toBe(2);
        });
    });
});

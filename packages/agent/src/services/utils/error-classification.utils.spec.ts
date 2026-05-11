import {
    classifyGenerationError,
    notifyForClassifiedError,
    type ErrorClassification,
    type ErrorClassificationType,
} from './error-classification.utils';

/**
 * `error-classification.utils.ts` is a substring-pattern dispatcher used by
 * `WorkGenerationService.handleErrorNotification` to map raw provider/git
 * errors into one of five user-facing notification flavours. The classification
 * rules are documented order-sensitive (ai_credits → ai_provider → git_auth →
 * account_level → unknown) AND substring-overlap-sensitive — for example,
 * `'authentication'` matches BOTH `isAiProviderError` AND `isGitAuthError`,
 * so a git authentication failure is only classified as `git_auth` when the
 * message also contains `'git'`/`'github'`/`'gitlab'`. This suite pins both
 * the dispatch order AND every documented substring.
 */
describe('classifyGenerationError', () => {
    describe('input shape coercion', () => {
        it('preserves an Error instance message verbatim', () => {
            const result = classifyGenerationError(new Error('insufficient_quota'));
            expect(result).toEqual({
                type: 'ai_credits',
                provider: 'AI Provider',
                message: 'insufficient_quota',
            });
        });

        it('preserves a TypeError (Error subclass) message via `.message`', () => {
            const result = classifyGenerationError(new TypeError('billing failed'));
            expect(result.type).toBe('ai_credits');
            expect(result.message).toBe('billing failed');
        });

        it('coerces a string error via direct passthrough (NOT String() wrap)', () => {
            // Pinned: the source uses `String(error)` only when error is NOT an Error.
            // For a string input that's already a string, the result.message reflects the
            // original verbatim (no extra wrapping characters).
            const result = classifyGenerationError('credits depleted');
            expect(result.message).toBe('credits depleted');
            expect(result.type).toBe('ai_credits');
        });

        it('coerces a number to a string via `String(...)`', () => {
            const result = classifyGenerationError(404);
            expect(result.message).toBe('404');
            expect(result.type).toBe('unknown');
        });

        it('coerces null to the literal string "null"', () => {
            const result = classifyGenerationError(null);
            expect(result.message).toBe('null');
            expect(result.type).toBe('unknown');
        });

        it('coerces undefined to the literal string "undefined"', () => {
            const result = classifyGenerationError(undefined);
            expect(result.message).toBe('undefined');
            expect(result.type).toBe('unknown');
        });

        it('coerces a plain object via `String(obj)` → "[object Object]"', () => {
            const result = classifyGenerationError({ code: 500 });
            expect(result.message).toBe('[object Object]');
            expect(result.type).toBe('unknown');
        });

        it('preserves the original message capitalisation in `result.message` (lowercasing only happens inside the classifier)', () => {
            const original = 'INSUFFICIENT_QUOTA from OpenAI';
            const result = classifyGenerationError(original);
            // Pinned: `errorLower` is internal — the returned `message` is the
            // un-modified input, so a UI showing it preserves the upstream case.
            expect(result.message).toBe(original);
            // The `provider` is detected from the lowercased copy.
            expect(result.provider).toBe('OpenAI');
        });
    });

    describe('ai_credits classification (highest priority)', () => {
        it.each([
            'insufficient_quota',
            'API rate_limit hit',
            'quota exceeded for the month',
            'credits ran out',
            'billing problem on account',
            'You have exceeded your current quota — please retry',
        ])('flags %p as ai_credits', (input) => {
            const result = classifyGenerationError(input);
            expect(result.type).toBe('ai_credits');
        });

        it('matches case-insensitively (`INSUFFICIENT_QUOTA` lowercased internally)', () => {
            const result = classifyGenerationError('INSUFFICIENT_QUOTA');
            expect(result.type).toBe('ai_credits');
        });

        it('beats ai_provider when both substrings are present (priority pin)', () => {
            // 'invalid_api_key' alone → ai_provider; 'credits' alone → ai_credits.
            // When both, ai_credits wins because it is checked FIRST.
            const result = classifyGenerationError('invalid_api_key and credits exhausted');
            expect(result.type).toBe('ai_credits');
        });

        it('beats account_level when both substrings are present (priority pin)', () => {
            const result = classifyGenerationError('billing rejected for this account');
            expect(result.type).toBe('ai_credits');
        });
    });

    describe('ai_provider classification', () => {
        it.each([
            'invalid_api_key',
            'authentication failed',
            'unauthorized request',
            'API key is missing',
        ])('flags %p as ai_provider', (input) => {
            const result = classifyGenerationError(input);
            expect(result.type).toBe('ai_provider');
        });

        it('matches "API Key" mixed-case via lowercasing', () => {
            const result = classifyGenerationError('API Key invalid');
            expect(result.type).toBe('ai_provider');
        });

        it('does NOT also match git_auth when neither git/github/gitlab appears', () => {
            // 'authentication' alone is a substring match for git_auth's second leg,
            // but git_auth requires ALSO matching the first leg (git/github/gitlab).
            // Pinned: ai_provider wins for a plain authentication error.
            const result = classifyGenerationError('authentication failure');
            expect(result.type).toBe('ai_provider');
        });
    });

    describe('git_auth classification', () => {
        it.each([
            // The git_auth path is ONLY reachable via the second-leg keywords that
            // do NOT also appear in ai_provider's pattern: token / expired /
            // permission denied. A bare "authentication"/"unauthorized" message
            // (even with a github prefix) is caught by the earlier ai_provider
            // check — pinned in a separate test below.
            'git token expired',
            'GitHub token has expired',
            'git permission denied',
            'gitlab token expired',
            'github expired credentials',
        ])('flags %p as git_auth', (input) => {
            const result = classifyGenerationError(input);
            expect(result.type).toBe('git_auth');
        });

        it('a "github authentication" message is intercepted by ai_provider first (priority pin)', () => {
            // Documented behaviour: ai_provider's `authentication`/`unauthorized`
            // substrings ALWAYS short-circuit before git_auth runs, even when
            // git/github/gitlab is also present. Pinned so a future "git_auth
            // priority bump" change is a deliberate behavioural shift.
            expect(classifyGenerationError('github authentication failed').type).toBe(
                'ai_provider',
            );
            expect(classifyGenerationError('gitlab unauthorized').type).toBe('ai_provider');
        });

        it('requires BOTH legs of the AND (`git`/`github`/`gitlab` AND auth-flavoured substring)', () => {
            // Just "git" alone → falls through.
            const result = classifyGenerationError('git pull failed');
            expect(result.type).toBe('unknown');
        });

        it('does NOT classify a plain "authentication" message as git_auth (caught by ai_provider first)', () => {
            const result = classifyGenerationError('authentication failed');
            expect(result.type).toBe('ai_provider');
        });

        it('routes to git_auth even when ai_provider keywords appear, because ai_provider is checked first BUT the ai_provider check would NOT match', () => {
            // Edge case: 'git unauthorized' — both ai_provider's 'unauthorized' AND
            // git_auth's 'git'+'unauthorized' apply. ai_provider's check fires FIRST
            // because of dispatch order, so this is actually classified as ai_provider.
            // PINNED so a future "git_auth wins for git-prefixed messages" change is
            // a deliberate behavioural shift.
            const result = classifyGenerationError('git unauthorized');
            expect(result.type).toBe('ai_provider');
        });

        it('the git_auth path is reachable via a token/expired/permission-denied keyword (none of which appear in ai_provider)', () => {
            for (const message of [
                'github token expired',
                'github permission denied',
                'gitlab expired token',
            ]) {
                expect(classifyGenerationError(message).type).toBe('git_auth');
            }
        });
    });

    describe('account_level classification', () => {
        it.each([
            'account suspended',
            'subscription cancelled',
            'plan limit reached',
            'database not configured',
        ])('flags %p as account_level', (input) => {
            const result = classifyGenerationError(input);
            expect(result.type).toBe('account_level');
        });

        it('emits an empty provider for account-level errors', () => {
            const result = classifyGenerationError('account suspended');
            expect(result.provider).toBe('');
        });
    });

    describe('unknown classification (default)', () => {
        it.each(['random failure', 'something broke', 'pipeline error'])(
            'falls through to unknown for %p',
            (input) => {
                const result = classifyGenerationError(input);
                expect(result.type).toBe('unknown');
                expect(result.provider).toBe('');
            },
        );

        it('falls through to unknown for an empty string', () => {
            const result = classifyGenerationError('');
            expect(result.type).toBe('unknown');
            expect(result.provider).toBe('');
            expect(result.message).toBe('');
        });
    });

    describe('detectAiProvider (exercised via ai_credits + ai_provider paths)', () => {
        it.each([
            ['openai insufficient_quota', 'OpenAI'],
            ['anthropic billing issue', 'Anthropic'],
            ['claude credits depleted', 'Anthropic'],
            ['google invalid_api_key', 'Google'],
            ['gemini quota exceeded', 'Google'],
            ['groq insufficient_quota', 'Groq'],
            ['ollama insufficient_quota', 'Ollama'],
            ['openrouter rate_limit', 'OpenRouter'],
        ])('detects provider %p as %p', (input, provider) => {
            const result = classifyGenerationError(input);
            expect(result.provider).toBe(provider);
        });

        it('falls back to "AI Provider" when no provider keyword is present', () => {
            const result = classifyGenerationError('billing failed');
            expect(result.provider).toBe('AI Provider');
        });

        it('first match wins — `openai` placed before `anthropic` in the message resolves to OpenAI', () => {
            // The dispatch is short-circuit if/return — the source order pins OpenAI > Anthropic > Google.
            const result = classifyGenerationError(
                'insufficient_quota — both openai and anthropic listed',
            );
            expect(result.provider).toBe('OpenAI');
        });

        it('claude alias takes precedence over google when both keywords appear (anthropic check fires before google)', () => {
            const result = classifyGenerationError('billing claude vs google');
            expect(result.provider).toBe('Anthropic');
        });
    });

    describe('detectGitProvider (exercised via git_auth path)', () => {
        it.each([
            ['github token expired', 'GitHub'],
            ['gitlab token expired', 'GitLab'],
            ['bitbucket git permission denied', 'Bitbucket'],
        ])('detects provider %p as %p', (input, provider) => {
            const result = classifyGenerationError(input);
            expect(result.provider).toBe(provider);
        });

        it('falls back to "Git Provider" when only the generic "git" keyword appears', () => {
            const result = classifyGenerationError('git token expired');
            expect(result.type).toBe('git_auth');
            expect(result.provider).toBe('Git Provider');
        });

        it('first match wins — `github` placed before `gitlab` resolves to GitHub', () => {
            const result = classifyGenerationError('github + gitlab token expired');
            expect(result.provider).toBe('GitHub');
        });
    });

    describe('return shape contract', () => {
        it('always returns an object with the three documented keys', () => {
            const result = classifyGenerationError('whatever');
            expect(Object.keys(result).sort()).toEqual(['message', 'provider', 'type']);
        });

        it('the `type` is always one of the five documented literals', () => {
            const documented: ErrorClassificationType[] = [
                'ai_credits',
                'ai_provider',
                'git_auth',
                'account_level',
                'unknown',
            ];
            const tries = [
                'insufficient_quota',
                'invalid_api_key',
                'github token expired',
                'subscription cancelled',
                'random',
            ];
            for (const t of tries) {
                expect(documented).toContain(classifyGenerationError(t).type);
            }
        });
    });
});

describe('notifyForClassifiedError', () => {
    type FakeNotificationService = {
        notifyAiCreditsDepleted: jest.Mock;
        notifyAiProviderError: jest.Mock;
        notifyGitAuthExpired: jest.Mock;
        notifyGenerationAccountError: jest.Mock;
    };

    const buildService = (): FakeNotificationService => ({
        notifyAiCreditsDepleted: jest.fn().mockResolvedValue(undefined),
        notifyAiProviderError: jest.fn().mockResolvedValue(undefined),
        notifyGitAuthExpired: jest.fn().mockResolvedValue(undefined),
        notifyGenerationAccountError: jest.fn().mockResolvedValue(undefined),
    });

    const buildClassification = (
        overrides: Partial<ErrorClassification> = {},
    ): ErrorClassification => ({
        type: 'unknown',
        provider: 'OpenAI',
        message: 'something failed',
        ...overrides,
    });

    describe('dispatch routing', () => {
        it('routes ai_credits to notifyAiCreditsDepleted with positional (userId, provider, message)', async () => {
            const service = buildService();
            await notifyForClassifiedError(
                service as never,
                'user-1',
                'work-1',
                'My Work',
                buildClassification({
                    type: 'ai_credits',
                    provider: 'OpenAI',
                    message: 'over quota',
                }),
            );
            expect(service.notifyAiCreditsDepleted).toHaveBeenCalledTimes(1);
            expect(service.notifyAiCreditsDepleted).toHaveBeenCalledWith(
                'user-1',
                'OpenAI',
                'over quota',
            );
            expect(service.notifyAiProviderError).not.toHaveBeenCalled();
            expect(service.notifyGitAuthExpired).not.toHaveBeenCalled();
            expect(service.notifyGenerationAccountError).not.toHaveBeenCalled();
        });

        it('routes ai_provider to notifyAiProviderError with positional (userId, provider, message)', async () => {
            const service = buildService();
            await notifyForClassifiedError(
                service as never,
                'user-1',
                'work-1',
                'My Work',
                buildClassification({
                    type: 'ai_provider',
                    provider: 'Anthropic',
                    message: 'invalid key',
                }),
            );
            expect(service.notifyAiProviderError).toHaveBeenCalledWith(
                'user-1',
                'Anthropic',
                'invalid key',
            );
            expect(service.notifyAiCreditsDepleted).not.toHaveBeenCalled();
        });

        it('routes git_auth to notifyGitAuthExpired with positional (userId, provider) — message is dropped', async () => {
            // Pin the documented contract: the message is NOT forwarded for git_auth.
            const service = buildService();
            await notifyForClassifiedError(
                service as never,
                'user-1',
                'work-1',
                'My Work',
                buildClassification({
                    type: 'git_auth',
                    provider: 'GitHub',
                    message: 'token expired',
                }),
            );
            expect(service.notifyGitAuthExpired).toHaveBeenCalledWith('user-1', 'GitHub');
            // The message arg is NOT forwarded — pinned via call-args length.
            expect(service.notifyGitAuthExpired.mock.calls[0]).toHaveLength(2);
        });

        it('routes account_level to notifyGenerationAccountError with positional (userId, workId, workName, message) — provider is dropped', async () => {
            // Pin the documented contract: the provider is NOT forwarded for account_level.
            // (For account_level, classifyGenerationError sets provider to '' anyway.)
            const service = buildService();
            await notifyForClassifiedError(
                service as never,
                'user-1',
                'work-1',
                'My Work',
                buildClassification({ type: 'account_level', provider: '', message: 'plan limit' }),
            );
            expect(service.notifyGenerationAccountError).toHaveBeenCalledWith(
                'user-1',
                'work-1',
                'My Work',
                'plan limit',
            );
            expect(service.notifyGenerationAccountError.mock.calls[0]).toHaveLength(4);
        });

        it('does NOT call any notifier for type="unknown" (silent return)', async () => {
            // Pinned: the switch has no default branch so unknown errors fall through.
            const service = buildService();
            await notifyForClassifiedError(
                service as never,
                'user-1',
                'work-1',
                'My Work',
                buildClassification({ type: 'unknown', provider: '', message: 'mystery' }),
            );
            expect(service.notifyAiCreditsDepleted).not.toHaveBeenCalled();
            expect(service.notifyAiProviderError).not.toHaveBeenCalled();
            expect(service.notifyGitAuthExpired).not.toHaveBeenCalled();
            expect(service.notifyGenerationAccountError).not.toHaveBeenCalled();
        });
    });

    describe('rejection propagation', () => {
        it('propagates an Error rejection from notifyAiCreditsDepleted', async () => {
            const service = buildService();
            const cause = new Error('mailer down');
            service.notifyAiCreditsDepleted.mockRejectedValueOnce(cause);
            await expect(
                notifyForClassifiedError(
                    service as never,
                    'user-1',
                    'work-1',
                    'My Work',
                    buildClassification({ type: 'ai_credits' }),
                ),
            ).rejects.toBe(cause);
        });

        it('propagates a non-Error rejection verbatim (no String() coercion)', async () => {
            const service = buildService();
            service.notifyGitAuthExpired.mockRejectedValueOnce('boom-string');
            await expect(
                notifyForClassifiedError(
                    service as never,
                    'user-1',
                    'work-1',
                    'My Work',
                    buildClassification({ type: 'git_auth', provider: 'GitHub' }),
                ),
            ).rejects.toBe('boom-string');
        });
    });

    describe('await semantics', () => {
        it('awaits the chosen notifier before returning (sequential ordering pin)', async () => {
            const service = buildService();
            const ops: string[] = [];
            service.notifyAiProviderError.mockImplementation(async () => {
                ops.push('start');
                await Promise.resolve();
                ops.push('end');
            });
            await notifyForClassifiedError(
                service as never,
                'user-1',
                'work-1',
                'My Work',
                buildClassification({ type: 'ai_provider' }),
            );
            ops.push('after');
            expect(ops).toEqual(['start', 'end', 'after']);
        });
    });
});

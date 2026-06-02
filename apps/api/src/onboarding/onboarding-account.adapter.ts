import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
    AuthAccountRepository,
    GitHubAppUserLinkRepository,
    UserRepository,
} from '@ever-works/agent/database';
import type { OnboardingAccountUpsert } from '@ever-works/agent/onboarding';
import { UsernameAllocatorService } from '@src/users/services/username-allocator.service';

/**
 * Api-side implementation of `OnboardingAccountUpsert` (T9b).
 *
 * Mirrors the existing `GitHubAppOnboardingService.findOrCreateLocalUser`
 * pattern: looks up the link table → falls back to the auth account by
 * provider account id → falls back to email → creates a fresh user when
 * nothing matches. Either way we end up with a user row plus an
 * `auth_accounts` row that records the GitHub identity and the latest
 * access token (encrypted at rest by the repository).
 *
 * The resulting `accountId` is the User UUID — the same value used as
 * `userId` everywhere else in the platform.
 */
@Injectable()
export class OnboardingAccountAdapter implements OnboardingAccountUpsert {
    private readonly logger = new Logger(OnboardingAccountAdapter.name);

    constructor(
        private readonly users: UserRepository,
        private readonly authAccounts: AuthAccountRepository,
        private readonly githubLinks: GitHubAppUserLinkRepository,
        private readonly usernameAllocator: UsernameAllocatorService,
    ) {}

    async upsertFromGithub(input: {
        githubUserId: string;
        login: string;
        email?: string;
        avatarUrl?: string;
        accessToken: string;
    }): Promise<{ accountId: string }> {
        const existingLink = await this.githubLinks.findByGithubUserId(input.githubUserId);
        let user = existingLink ? await this.users.findById(existingLink.userId) : null;

        if (!user) {
            const existingProviderAccount = await this.authAccounts.findProviderAccountByAccountId(
                'github',
                input.githubUserId,
            );
            if (existingProviderAccount) {
                user = await this.users.findById(existingProviderAccount.userId);
            }
        }

        if (!user && input.email) {
            user = await this.users.findByEmail(input.email);
        }

        if (!user) {
            const username = await this.resolveUniqueUsername(
                input.login || `agent-${input.githubUserId}`,
            );
            const email = input.email || `agent-${input.githubUserId}@users.noreply.ever.works`;
            user = await this.users.create({
                username,
                email,
                password: randomUUID(), // never used for login — provider-only registration
                registrationProvider: 'github',
                avatar: input.avatarUrl || undefined,
                emailVerified: false,
                isActive: true,
                lastLoginAt: new Date(),
            } as any);
            this.logger.log(`onboarding.account_created userId=${user.id} login=${input.login}`);
        } else {
            this.logger.log(`onboarding.account_linked userId=${user.id} login=${input.login}`);
        }

        await this.authAccounts
            .upsertProviderAccount({
                userId: user.id,
                providerId: 'github',
                accountId: input.githubUserId,
                username: input.login,
                email: input.email ?? null,
                accessToken: input.accessToken,
                refreshToken: null,
                accessTokenExpiresAt: null,
                refreshTokenExpiresAt: null,
                scope: null,
                tokenType: 'Bearer',
                metadata: {
                    providerUserId: input.githubUserId,
                    login: input.login,
                    onboardingChannel: 'agent-zero-friction',
                },
            } as any)
            .catch((err) => {
                this.logger.warn(
                    `onboarding.account_link_failed userId=${user!.id} reason=${describeError(err)}`,
                );
            });

        await this.githubLinks
            .upsertLink({
                userId: user.id,
                githubUserId: input.githubUserId,
                githubLogin: input.login,
                githubNodeId: null,
                accessToken: input.accessToken,
                refreshToken: null,
                accessTokenExpiresAt: null,
                refreshTokenExpiresAt: null,
                scope: null,
            } as any)
            .catch((err) => {
                this.logger.warn(
                    `onboarding.gh_link_failed userId=${user!.id} reason=${describeError(err)}`,
                );
            });

        return { accountId: user.id };
    }

    /**
     * Pick a username slot that isn't taken yet.
     *
     * Sanitises `base` (alnum + `_` + `-` only, max 32 chars; falls back
     * to `'agent'` if everything was stripped), then probes the users
     * table for `${sanitized}`, `${sanitized}-2`, `${sanitized}-3`, …
     * up to suffix 50.
     *
     * If 50 sequential slots are all taken (extremely unlikely in
     * practice — implies a popular GitHub login plus an aggressively
     * concurrent onboarding flow), short-circuit to
     * `${sanitized}-${randomUUID().slice(0, 8)}` instead of looping
     * forever. The 8-hex-char suffix is enough entropy that a single
     * fall-through call effectively always lands in an unused slot.
     *
     * Race window: the lookup-then-insert is NOT atomic — between
     * `findByUsername` returning null and the eventual `users.create`,
     * a parallel onboarding could grab the same slot. The DB UNIQUE
     * constraint on `users.username` catches the race and the create
     * call throws; the caller is responsible for retrying onboarding
     * if the throw matters to them.
     */
    /**
     * EW-652 (Tenants & Organizations Phase 0) — delegate to the shared
     * `UsernameAllocatorService.allocateUsername`. The previous inline
     * loop's behavior (sanitize + suffix on collision + random fallback)
     * is preserved by the allocator with the same semantics and an
     * identical 10k-attempt safety valve. Method kept as a thin wrapper
     * so the file's public surface and existing test mocks stay stable.
     */
    private async resolveUniqueUsername(base: string): Promise<string> {
        return this.usernameAllocator.allocateUsername(base || 'agent');
    }
}

// Security: strip known GitHub token patterns from error messages before logging to prevent
// credential fragments leaking into log aggregators (Sentry, Datadog) via Octokit error text.
const GITHUB_TOKEN_PATTERN =
    /\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{10,}\b/g;

function describeError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
}

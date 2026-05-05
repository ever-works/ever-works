import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
    AuthAccountRepository,
    GitHubAppUserLinkRepository,
    UserRepository,
} from '@ever-works/agent/database';
import type { OnboardingAccountUpsert } from '@ever-works/agent/onboarding';

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

    private async resolveUniqueUsername(base: string): Promise<string> {
        const sanitized = (base || 'agent').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'agent';
        let candidate = sanitized;
        let suffix = 1;
        while (await this.users.findByUsername(candidate)) {
            suffix += 1;
            candidate = `${sanitized}-${suffix}`;
            if (suffix > 50) {
                candidate = `${sanitized}-${randomUUID().slice(0, 8)}`;
                break;
            }
        }
        return candidate;
    }
}

function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

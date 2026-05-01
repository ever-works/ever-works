import {
    AuthAccountRepository,
    GitHubAppInstallationRepository,
    GitHubAppUserLinkRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { GitHubAppInstallation, User } from '@ever-works/agent/entities';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { config } from '@src/config/constants';
import * as bcrypt from 'bcrypt';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { GitHubAppService } from './github-app.service';

type SetupStatePayload = {
    installationId: string;
    redirectTo?: string;
    setupAction?: string;
    issuedAt: number;
};

@Injectable()
export class GitHubAppOnboardingService {
    constructor(
        private readonly gitHubAppService: GitHubAppService,
        private readonly gitHubAppInstallationRepository: GitHubAppInstallationRepository,
        private readonly gitHubAppUserLinkRepository: GitHubAppUserLinkRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly userRepository: UserRepository,
    ) {}

    async beginSetup(input: { installationId: string; redirectTo?: string; setupAction?: string }) {
        const installation = await this.gitHubAppService.getInstallation(input.installationId);
        await this.gitHubAppInstallationRepository.upsertFromGithub({
            installationId: String(installation.id),
            appSlug: installation.app_slug || config.githubApp.slug(),
            accountLogin: installation.account?.login || '',
            accountType: installation.account?.type || 'User',
            targetType: installation.target_type || 'User',
            deletedAt: null,
            suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
            rawPayload: installation as unknown as Record<string, unknown>,
        });

        const state = this.signState({
            installationId: String(installation.id),
            redirectTo: this.normalizeRedirectTo(input.redirectTo),
            setupAction: input.setupAction,
            issuedAt: Date.now(),
        });

        return {
            url: this.gitHubAppService.getUserAuthorizationUrl(state),
        };
    }

    async completeUserAuth(input: { code: string; state: string }): Promise<{
        user: User;
        installation: GitHubAppInstallation;
        redirectTo?: string;
    }> {
        const state = this.verifyState(input.state);
        const tokenResult = await this.gitHubAppService.exchangeUserCode(input.code);
        const githubUser = await this.gitHubAppService.getAuthenticatedGithubUser(
            tokenResult.access_token,
        );

        const user = await this.findOrCreateLocalUser({
            githubUserId: githubUser.githubUserId,
            login: githubUser.login,
            email: githubUser.email,
            emailVerified: githubUser.emailVerified,
            avatarUrl: githubUser.avatarUrl,
            accessToken: tokenResult.access_token,
            refreshToken: tokenResult.refresh_token || null,
            accessTokenExpiresAt: tokenResult.expires_in
                ? new Date(Date.now() + tokenResult.expires_in * 1000)
                : null,
            refreshTokenExpiresAt: tokenResult.refresh_token_expires_in
                ? new Date(Date.now() + tokenResult.refresh_token_expires_in * 1000)
                : null,
            scope: tokenResult.scope || null,
            nodeId: githubUser.nodeId,
        });

        const installationDetails = await this.gitHubAppService.getInstallation(
            state.installationId,
        );
        const existingInstallation = await this.gitHubAppInstallationRepository.findByInstallationId(
            String(installationDetails.id),
        );
        const installation = await this.gitHubAppInstallationRepository.upsertFromGithub({
            installationId: String(installationDetails.id),
            appSlug: installationDetails.app_slug || config.githubApp.slug(),
            accountLogin: installationDetails.account?.login || '',
            accountType: installationDetails.account?.type || 'User',
            targetType: installationDetails.target_type || 'User',
            createdByUserId: existingInstallation?.createdByUserId ?? user.id,
            createdByGithubUserId:
                existingInstallation?.createdByGithubUserId ?? githubUser.githubUserId,
            deletedAt: null,
            suspendedAt: installationDetails.suspended_at
                ? new Date(installationDetails.suspended_at)
                : null,
            rawPayload: installationDetails as unknown as Record<string, unknown>,
        });

        return {
            user,
            installation,
            redirectTo: state.redirectTo,
        };
    }

    private async findOrCreateLocalUser(input: {
        githubUserId: string;
        login: string;
        email: string | null;
        emailVerified: boolean;
        avatarUrl: string | null;
        accessToken: string;
        refreshToken: string | null;
        accessTokenExpiresAt: Date | null;
        refreshTokenExpiresAt: Date | null;
        scope: string | null;
        nodeId: string | null;
    }) {
        const existingLink = await this.gitHubAppUserLinkRepository.findByGithubUserId(
            input.githubUserId,
        );
        let user = existingLink ? await this.userRepository.findById(existingLink.userId) : null;

        if (!user) {
            const existingAuthAccount =
                await this.authAccountRepository.findProviderAccountByAccountId(
                    'github',
                    input.githubUserId,
                );
            if (existingAuthAccount) {
                user = await this.userRepository.findById(existingAuthAccount.userId);
            }
        }

        if (!user && input.email) {
            user = await this.userRepository.findByEmail(input.email);
            if (user && !input.emailVerified) {
                throw new UnauthorizedException(
                    'Unable to link this GitHub App user because the provider email is not verified',
                );
            }
        }

        if (!user) {
            const username = await this.resolveUniqueUsername(input.login);
            const email =
                input.email || `github-app-${input.githubUserId}@users.noreply.ever.works`;

            user = await this.userRepository.create({
                username,
                email,
                password: await bcrypt.hash(randomUUID(), 10),
                registrationProvider: 'github',
                avatar: input.avatarUrl || undefined,
                emailVerified: input.email ? input.emailVerified : false,
                isActive: true,
                lastLoginAt: new Date(),
            });
        } else {
            const nextEmail =
                input.email && user.email.endsWith('@users.noreply.ever.works')
                    ? input.email
                    : user.email;
            user = await this.userRepository.update(user.id, {
                username: user.username || input.login,
                avatar: input.avatarUrl || user.avatar,
                email: nextEmail,
                emailVerified: user.emailVerified || (input.email ? input.emailVerified : false),
                registrationProvider: 'github',
                lastLoginAt: new Date(),
            });
        }

        await this.authAccountRepository.upsertProviderAccount({
            userId: user.id,
            providerId: 'github',
            accountId: input.githubUserId,
            username: input.login,
            email: input.email,
            accessToken: input.accessToken,
            refreshToken: input.refreshToken,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt,
            scope: input.scope,
            tokenType: 'Bearer',
            metadata: {
                nodeId: input.nodeId,
                providerUserId: input.githubUserId,
                login: input.login,
            },
        });

        await this.gitHubAppUserLinkRepository.upsertLink({
            userId: user.id,
            githubUserId: input.githubUserId,
            githubLogin: input.login,
            githubNodeId: input.nodeId,
            accessToken: input.accessToken,
            refreshToken: input.refreshToken,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt,
            scope: input.scope,
        });

        return user;
    }

    private async resolveUniqueUsername(baseUsername: string): Promise<string> {
        const sanitizedBase = (baseUsername || 'github-user').trim() || 'github-user';
        let candidate = sanitizedBase;
        let suffix = 1;

        while (await this.userRepository.findByUsername(candidate)) {
            suffix += 1;
            candidate = `${sanitizedBase}-${suffix}`;
        }

        return candidate;
    }

    private signState(payload: SetupStatePayload): string {
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const signature = createHmac('sha256', config.auth.secret())
            .update(encodedPayload)
            .digest('base64url');

        return `${encodedPayload}.${signature}`;
    }

    private verifyState(state: string): SetupStatePayload {
        const [encodedPayload, signature] = state.split('.');
        if (!encodedPayload || !signature) {
            throw new BadRequestException('Invalid GitHub App state');
        }

        const expectedSignature = createHmac('sha256', config.auth.secret())
            .update(encodedPayload)
            .digest('base64url');

        if (signature.length !== expectedSignature.length) {
            throw new BadRequestException('Invalid GitHub App state signature');
        }

        const isValid = timingSafeEqual(
            Buffer.from(signature, 'utf8'),
            Buffer.from(expectedSignature, 'utf8'),
        );
        if (!isValid) {
            throw new BadRequestException('Invalid GitHub App state signature');
        }

        let payload: SetupStatePayload;
        try {
            payload = JSON.parse(
                Buffer.from(encodedPayload, 'base64url').toString('utf8'),
            ) as SetupStatePayload;
        } catch {
            throw new BadRequestException('Invalid GitHub App state payload');
        }

        if (!payload.installationId || !payload.issuedAt) {
            throw new BadRequestException('Invalid GitHub App state payload');
        }

        if (Date.now() - payload.issuedAt > 10 * 60 * 1000) {
            throw new BadRequestException('GitHub App setup state expired');
        }

        return payload;
    }

    private normalizeRedirectTo(redirectTo?: string): string | undefined {
        if (!redirectTo || typeof redirectTo !== 'string') {
            return undefined;
        }

        return redirectTo.startsWith('/') ? redirectTo : undefined;
    }
}

import {
    AuthAccountRepository,
    GitHubAppInstallationRepository,
    GitHubAppUserLinkRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { GitHubAppInstallation, User } from '@ever-works/agent/entities';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { config } from '@src/config/constants';
import * as bcrypt from 'bcrypt';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GitHubAppService, type GitHubInstallationResponse } from './github-app.service';
import { UsernameAllocatorService } from '@src/users/services/username-allocator.service';

type SetupStatePayload = {
    installationId: string;
    redirectTo?: string;
    setupAction?: string;
    issuedAt: number;
    /**
     * 10-09 handover item 13 — sha256 (base64url) of the browser-binding
     * nonce handed to the web tier at setup, which keeps the nonce in an
     * HttpOnly cookie on the INITIATING browser. The callback must present
     * the same nonce, so a callback URL replayed from another browser (or a
     * state lifted from a log) cannot complete the claim.
     */
    binding: string;
};

/** Lifetime of a setup state (and of the browser-binding cookie that pairs with it). */
export const GITHUB_APP_SETUP_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Domain separation for the state HMAC: the raw auth secret also signs
 * sessions, so a state is signed with a key derived for THIS purpose only.
 */
const SETUP_STATE_KEY_LABEL = 'ever-works:github-app-setup-state:v2';

/** The repositories one onboarding claim writes through, bound to one transaction. */
type OnboardingRepos = {
    users: UserRepository;
    authAccounts: AuthAccountRepository;
    links: GitHubAppUserLinkRepository;
    installations: GitHubAppInstallationRepository;
};

@Injectable()
export class GitHubAppOnboardingService {
    private readonly logger = new Logger(GitHubAppOnboardingService.name);

    constructor(
        private readonly gitHubAppService: GitHubAppService,
        private readonly gitHubAppInstallationRepository: GitHubAppInstallationRepository,
        private readonly gitHubAppUserLinkRepository: GitHubAppUserLinkRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly userRepository: UserRepository,
        private readonly usernameAllocator: UsernameAllocatorService,
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

        // Item 13: bind the state to THIS browser. The nonce leaves the API
        // only towards the web tier, which keeps it in an HttpOnly cookie
        // scoped to the GitHub App routes; the state carries just its hash.
        const binding = randomBytes(32).toString('base64url');
        const state = this.signState({
            installationId: String(installation.id),
            redirectTo: this.normalizeRedirectTo(input.redirectTo),
            setupAction: input.setupAction,
            issuedAt: Date.now(),
            binding: hashBinding(binding),
        });

        return {
            url: this.gitHubAppService.getUserAuthorizationUrl(state),
            binding,
            bindingTtlSeconds: Math.floor(GITHUB_APP_SETUP_STATE_TTL_MS / 1000),
        };
    }

    async completeUserAuth(input: {
        code: string;
        state: string;
        binding?: string | null;
    }): Promise<{
        user: User;
        installation: GitHubAppInstallation;
        redirectTo?: string;
    }> {
        const state = this.verifyState(input.state, input.binding ?? null);
        const tokenResult = await this.gitHubAppService.exchangeUserCode(input.code);
        const githubUser = await this.gitHubAppService.getAuthenticatedGithubUser(
            tokenResult.access_token,
        );

        // The signed state names an installation id chosen by whoever called the
        // public setup endpoint; the HMAC proves only that WE issued the state.
        // Before anything is written or the installation is bound to a local
        // user, prove the GitHub user who just authorized could have INSTALLED
        // it. Mere access is not enough: a read-only collaborator can see an
        // installation but must never be able to claim it.
        const installationDetails = await this.gitHubAppService.getInstallation(
            state.installationId,
        );
        await this.assertMayClaimInstallation({
            installation: installationDetails,
            githubUserId: githubUser.githubUserId,
            accessToken: tokenResult.access_token,
        });

        // Item 13: every write below — the local user, its `github` provider
        // account, the App user link, the installation row and its claim —
        // commits or rolls back TOGETHER. Before, a conflict on the link (or a
        // failed claim) left a freshly created user and provider account
        // behind. All reads and GitHub calls happened above, outside it.
        return this.inTransaction(async (repos) => {
            const user = await this.findOrCreateLocalUser(repos, {
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

            await repos.installations.upsertFromGithub({
                installationId: String(installationDetails.id),
                appSlug: installationDetails.app_slug || config.githubApp.slug(),
                accountLogin: installationDetails.account?.login || '',
                accountType: installationDetails.account?.type || 'User',
                targetType: installationDetails.target_type || 'User',
                deletedAt: null,
                suspendedAt: installationDetails.suspended_at
                    ? new Date(installationDetails.suspended_at)
                    : null,
                rawPayload: installationDetails as unknown as Record<string, unknown>,
            });
            const installation = await repos.installations.claimOwnershipIfUnassigned(
                String(installationDetails.id),
                user.id,
                githubUser.githubUserId,
            );

            if (!installation) {
                throw new BadRequestException('GitHub App installation could not be persisted');
            }

            return {
                user,
                installation,
                redirectTo: state.redirectTo,
            };
        });
    }

    /**
     * Run `work` with every onboarding repository bound to ONE transaction.
     * A unique-constraint race inside it (two browsers claiming the same
     * installation at the same instant) aborts the whole claim instead of
     * half-applying it; the user simply retries.
     */
    private async inTransaction<T>(work: (repos: OnboardingRepos) => Promise<T>): Promise<T> {
        return this.gitHubAppInstallationRepository.transaction((manager) =>
            work({
                users: this.userRepository.withManager(manager),
                authAccounts: this.authAccountRepository.withManager(manager),
                links: this.gitHubAppUserLinkRepository.withManager(manager),
                installations: this.gitHubAppInstallationRepository.withManager(manager),
            }),
        );
    }

    /**
     * Only someone who could have installed the App on that account may claim
     * the installation:
     *
     *  1. When the `installation.created` webhook already recorded the installer
     *     (`createdByGithubUserId`, from the HMAC-verified delivery's `sender`),
     *     that GitHub user — and nobody else — may claim it. No extra GitHub
     *     call or App permission is needed.
     *  2. Otherwise (the webhook has not arrived yet): a **User** installation
     *     may be claimed only by that account itself, and an **Organization**
     *     installation only by an active org admin.
     *  3. Anything else (unknown target type, missing account data) is refused.
     *
     * Throws 403 before any write.
     */
    private async assertMayClaimInstallation(input: {
        installation: GitHubInstallationResponse;
        githubUserId: string;
        accessToken: string;
    }): Promise<void> {
        const { installation, githubUserId, accessToken } = input;
        const installationId = String(installation.id);
        const refuse = (reason: string): never => {
            this.logger.warn(
                `Refused GitHub App installation claim (installation=${installationId}, reason=${reason})`,
            );
            throw new ForbiddenException(
                'Only the GitHub user who installed this GitHub App, the account it is installed on, or an organization admin can link this installation',
            );
        };

        const stored =
            await this.gitHubAppInstallationRepository.findByInstallationId(installationId);
        const recordedInstaller = stored?.createdByGithubUserId;
        if (recordedInstaller) {
            if (recordedInstaller === githubUserId) {
                return;
            }
            return refuse('not-the-recorded-installer');
        }

        const targetType = installation.target_type || installation.account?.type;
        if (targetType === 'User') {
            const accountId = installation.account?.id;
            if (
                accountId !== undefined &&
                accountId !== null &&
                String(accountId) === githubUserId
            ) {
                return;
            }
            return refuse('not-the-installation-account');
        }

        if (targetType === 'Organization') {
            const orgLogin = installation.account?.login;
            if (orgLogin && (await this.gitHubAppService.isActiveOrgAdmin(accessToken, orgLogin))) {
                return;
            }
            return refuse('not-an-active-org-admin');
        }

        return refuse('unsupported-target-type');
    }

    private async findOrCreateLocalUser(
        repos: OnboardingRepos,
        input: {
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
        },
    ) {
        // Identity resolution order matters: the GitHub user id is the only
        // identifier GitHub guarantees, so the App user link and the `github`
        // auth account (accountId = GitHub user id, written by both this flow
        // and the OAuth sign-in) are consulted BEFORE any email. The email path
        // below is reached only for a GitHub id we have never seen, and it can
        // never link an unverified email to an existing user.
        const existingLink = await repos.links.findByGithubUserId(input.githubUserId);
        let user = existingLink ? await repos.users.findById(existingLink.userId) : null;

        if (!user) {
            const existingAuthAccount = await repos.authAccounts.findProviderAccountByAccountId(
                'github',
                input.githubUserId,
            );
            if (existingAuthAccount) {
                user = await repos.users.findById(existingAuthAccount.userId);
                if (!user) {
                    // This GitHub id is already bound to a local account we cannot
                    // load. Falling through would create a second user for the
                    // same GitHub identity (and then fail the provider-account
                    // upsert with a conflict, leaving that user orphaned) — refuse
                    // before anything is written.
                    throw new ConflictException(
                        'This GitHub account is linked to a local account that could not be loaded',
                    );
                }
            }
        }

        if (!user && input.email) {
            user = await repos.users.findByEmail(input.email);
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

            user = await repos.users.create({
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
            // EW-617 G2: existing rows may now have null email (anonymous
            // users who connected GitHub before claiming an account). Treat
            // null the same as the placeholder noreply address — overwrite.
            const isPlaceholderEmail =
                !user.email || user.email.endsWith('@users.noreply.ever.works');
            const nextEmail = input.email && isPlaceholderEmail ? input.email : user.email;
            user = await repos.users.update(user.id, {
                username: user.username || input.login,
                avatar: input.avatarUrl || user.avatar,
                email: nextEmail,
                emailVerified: user.emailVerified || (input.email ? input.emailVerified : false),
                registrationProvider: 'github',
                lastLoginAt: new Date(),
            });
        }

        await repos.authAccounts.upsertProviderAccount({
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

        await repos.links.upsertLink({
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

    /**
     * EW-652 (Tenants & Organizations Phase 0) — moved to the shared
     * `UsernameAllocatorService.allocateUsername` so both this path and
     * the interactive UI flow (`/api/users/check-username`) go through
     * the same normalization + collision-suffix logic. Kept here as a
     * thin delegation so existing tests that stub this method continue
     * to work, and to preserve the public interface for future callers.
     */
    private async resolveUniqueUsername(baseUsername: string): Promise<string> {
        return this.usernameAllocator.allocateUsername(baseUsername || 'github-user');
    }

    private signState(payload: SetupStatePayload): string {
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const signature = createHmac('sha256', setupStateKey())
            .update(encodedPayload)
            .digest('base64url');

        return `${encodedPayload}.${signature}`;
    }

    private verifyState(state: string, binding: string | null): SetupStatePayload {
        const [encodedPayload, signature] = (typeof state === 'string' ? state : '').split('.');
        if (!encodedPayload || !signature) {
            throw new BadRequestException('Invalid GitHub App state');
        }

        const expectedSignature = createHmac('sha256', setupStateKey())
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

        if (Date.now() - payload.issuedAt > GITHUB_APP_SETUP_STATE_TTL_MS) {
            throw new BadRequestException('GitHub App setup state expired');
        }

        // Item 13: the callback must come from the browser that started the
        // setup. No cookie, or another browser's, is refused before any code
        // is exchanged or anything is written.
        if (
            typeof payload.binding !== 'string' ||
            typeof binding !== 'string' ||
            !binding ||
            !constantTimeEqual(hashBinding(binding), payload.binding)
        ) {
            this.logger.warn(
                `Refused GitHub App setup callback for installation ${payload.installationId}: not the browser that started it`,
            );
            throw new BadRequestException(
                'Finish the GitHub App setup in the browser where you started it',
            );
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

function setupStateKey(): Buffer {
    return createHmac('sha256', config.auth.secret()).update(SETUP_STATE_KEY_LABEL).digest();
}

function hashBinding(binding: string): string {
    return createHash('sha256').update(binding, 'utf8').digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

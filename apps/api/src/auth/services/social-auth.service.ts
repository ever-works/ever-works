import {
    BadGatewayException,
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { createGitHubOAuthHeaders } from '@ever-works/agent/utils';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { AuthProvider } from '../../config/constants';
import { AuthService } from './auth.service';
import {
    getSocialAuthProviderConfig,
    SOCIAL_AUTH_PROVIDERS,
} from '../config/social-auth.providers';
import type { SocialAuthProviderId, SocialAuthUser } from '../types/social-auth.types';
import { resolveGitHubAccountEmail } from '../utils/github-email.utils';

interface OAuthTokenResult {
    accessToken: string;
    refreshToken: string | null;
    tokenType: string | null;
    scope: string | null;
    expiresAt: Date | null;
}

interface GoogleUserInfo {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
}

interface GitHubUser {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
    node_id?: string;
    type?: string;
}

interface FacebookUser {
    id: string;
    name?: string;
    email?: string;
    picture?: {
        data?: {
            url?: string;
        };
    };
}

interface LinkedInUserInfo {
    sub: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    email?: string;
    email_verified?: boolean;
    picture?: string;
    locale?: string;
}

/** Which upstream OAuth call failed — surfaced in the safe client message. */
type UpstreamStep = 'token exchange' | 'user profile request';

/**
 * Upstream 4xx statuses that are NOT the end user's fault. These map like a
 * provider outage (502) rather than a rejected code (400).
 *
 *  - 408 Request Timeout / 429 Too Many Requests — provider-side or quota
 *    conditions. Telling the user to restart a flow that would fail again is
 *    the wrong advice.
 *  - 401 Unauthorized — OUR client credentials, not the user's grant. A
 *    rejected authorization code comes back 400 `invalid_grant`; 401 is
 *    `invalid_client`, meaning the platform's own client id/secret is wrong,
 *    revoked or expired (and on the userinfo step, that the token WE just
 *    obtained was refused). Both are platform misconfiguration.
 *
 *    401 matters beyond the status code the user sees. Mapped to 400 it was
 *    counted as a client error, so a total sign-in outage — every user of
 *    that provider failing — raised no 5xx alert at all and looked like a
 *    crowd of people mistyping something.
 */
const UPSTREAM_NOT_USER_FAULT_STATUSES: ReadonlySet<number> = new Set([401, 408, 429]);

@Injectable()
export class SocialAuthService {
    private readonly logger = new Logger(SocialAuthService.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly authService: AuthService,
    ) {}

    getAuthorizationUrl(providerId: string, callbackUrl?: string, state?: string): string {
        const provider = getSocialAuthProviderConfig(providerId);
        const redirectUri = callbackUrl || provider.callbackUrl();
        const scope = provider.scopes.join(provider.scopeSeparator || ' ');

        const params = new URLSearchParams({
            client_id: this.getClientIdOrThrow(provider.id),
            redirect_uri: redirectUri,
            response_type: 'code',
            scope,
        });

        if (state) {
            params.set('state', state);
        }

        if (provider.id === AuthProvider.GOOGLE) {
            params.set('access_type', 'offline');
            params.set('prompt', 'consent');
        }

        return `${provider.authorizationUrl}?${params.toString()}`;
    }

    async authenticate(providerId: string, code: string, callbackUrl?: string) {
        const provider = getSocialAuthProviderConfig(providerId);
        const redirectUri = callbackUrl || provider.callbackUrl();
        const tokens = await this.exchangeCodeForTokens(provider.id, code, redirectUri);
        const socialUser = await this.getSocialUser(provider.id, tokens.accessToken);

        return this.authService.validateSocialUser({
            ...socialUser,
            provider: provider.id,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenType: tokens.tokenType,
            scope: tokens.scope,
            expiresAt: tokens.expiresAt,
        });
    }

    getProviderDisplayName(providerId: string) {
        return getSocialAuthProviderConfig(providerId).displayName;
    }

    getConfiguredProviders(): SocialAuthProviderId[] {
        return (Object.keys(SOCIAL_AUTH_PROVIDERS) as SocialAuthProviderId[]).filter(
            (providerId) => {
                const provider = SOCIAL_AUTH_PROVIDERS[providerId];
                return Boolean(provider.clientId() && provider.clientSecret());
            },
        );
    }

    private async exchangeCodeForTokens(
        providerId: SocialAuthProviderId,
        code: string,
        redirectUri: string,
    ): Promise<OAuthTokenResult> {
        const provider = SOCIAL_AUTH_PROVIDERS[providerId];
        const params = new URLSearchParams({
            client_id: this.getClientIdOrThrow(providerId),
            client_secret: this.getClientSecretOrThrow(providerId),
            code,
            redirect_uri: redirectUri,
        });

        if (providerId !== AuthProvider.GITHUB) {
            params.set('grant_type', 'authorization_code');
        }

        const { data } = await this.callUpstream(providerId, 'token exchange', () =>
            firstValueFrom(
                this.httpService.post<Record<string, unknown>>(
                    provider.tokenUrl,
                    params.toString(),
                    {
                        headers: {
                            Accept: 'application/json',
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                    },
                ),
            ),
        );

        const accessToken = this.readString(data, 'access_token');
        const expiresIn = this.readNumber(data, 'expires_in');

        return {
            accessToken,
            refreshToken: this.readOptionalString(data, 'refresh_token'),
            tokenType: this.readOptionalString(data, 'token_type'),
            scope: this.readOptionalString(data, 'scope'),
            expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        };
    }

    private async getSocialUser(
        providerId: SocialAuthProviderId,
        accessToken: string,
    ): Promise<
        Omit<
            SocialAuthUser,
            'provider' | 'accessToken' | 'refreshToken' | 'tokenType' | 'scope' | 'expiresAt'
        >
    > {
        switch (providerId) {
            case AuthProvider.GITHUB:
                return this.getGitHubUser(accessToken);
            case AuthProvider.GOOGLE:
                return this.getGoogleUser(accessToken);
            case AuthProvider.FACEBOOK:
                return this.getFacebookUser(accessToken);
            case AuthProvider.LINKEDIN:
                return this.getLinkedInUser(accessToken);
        }
    }

    private async getGitHubUser(accessToken: string) {
        const headers = createGitHubOAuthHeaders(accessToken);

        const { data } = await this.callUpstream(AuthProvider.GITHUB, 'user profile request', () =>
            firstValueFrom(
                this.httpService.get<GitHubUser>('https://api.github.com/user', { headers }),
            ),
        );

        // `resolveGitHubAccountEmail` (shared with the GitHub App integration)
        // performs its own `/user/emails` request — wrap the call site so an
        // upstream failure there is mapped exactly like the ones above.
        const { email, emailVerified } = await this.callUpstream(
            AuthProvider.GITHUB,
            'user profile request',
            () => resolveGitHubAccountEmail(this.httpService, accessToken, data.email || null),
        );

        if (!email) {
            throw new BadRequestException('No email found in GitHub profile');
        }

        const displayName = data.name || data.login || email.split('@')[0];

        return {
            providerUserId: String(data.id),
            email,
            displayName,
            username: data.login || displayName,
            avatar: data.avatar_url || null,
            emailVerified,
            metadata: {
                login: data.login,
                nodeId: data.node_id,
                type: data.type,
            },
        };
    }

    private async getGoogleUser(accessToken: string) {
        const { data } = await this.callUpstream(AuthProvider.GOOGLE, 'user profile request', () =>
            firstValueFrom(
                this.httpService.get<GoogleUserInfo>(
                    'https://openidconnect.googleapis.com/v1/userinfo',
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                        },
                    },
                ),
            ),
        );

        if (!data.email) {
            throw new BadRequestException('No email found in Google profile');
        }

        const displayName = data.name || data.email.split('@')[0];

        return {
            providerUserId: data.sub,
            email: data.email,
            displayName,
            username: displayName,
            avatar: data.picture || null,
            emailVerified: data.email_verified !== false,
            metadata: {
                sub: data.sub,
            },
        };
    }

    private async getFacebookUser(accessToken: string) {
        const { data } = await this.callUpstream(
            AuthProvider.FACEBOOK,
            'user profile request',
            () =>
                firstValueFrom(
                    this.httpService.get<FacebookUser>('https://graph.facebook.com/me', {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                        },
                        params: {
                            fields: 'id,name,email,picture.type(large)',
                        },
                    }),
                ),
        );

        if (!data.email) {
            throw new BadRequestException('No email found in Facebook profile');
        }

        const displayName = data.name || data.email.split('@')[0];

        return {
            providerUserId: data.id,
            email: data.email,
            displayName,
            username: displayName,
            avatar: data.picture?.data?.url || null,
            emailVerified: false,
            metadata: {
                id: data.id,
            },
        };
    }

    private async getLinkedInUser(accessToken: string) {
        const { data } = await this.callUpstream(
            AuthProvider.LINKEDIN,
            'user profile request',
            () =>
                firstValueFrom(
                    this.httpService.get<LinkedInUserInfo>('https://api.linkedin.com/v2/userinfo', {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                        },
                    }),
                ),
        );

        if (!data.email) {
            throw new BadRequestException('No email found in LinkedIn profile');
        }

        const fallbackName = [data.given_name, data.family_name].filter(Boolean).join(' ');
        const displayName = data.name || fallbackName || data.email.split('@')[0];

        return {
            providerUserId: data.sub,
            email: data.email,
            displayName,
            username: displayName,
            avatar: data.picture || null,
            emailVerified: data.email_verified !== false,
            metadata: {
                sub: data.sub,
                locale: data.locale,
            },
        };
    }

    private getClientIdOrThrow(providerId: SocialAuthProviderId) {
        const value = SOCIAL_AUTH_PROVIDERS[providerId].clientId();
        if (!value) {
            throw new BadRequestException(`${providerId} client id is not configured`);
        }
        return value;
    }

    private getClientSecretOrThrow(providerId: SocialAuthProviderId) {
        const value = SOCIAL_AUTH_PROVIDERS[providerId].clientSecret();
        if (!value) {
            throw new BadRequestException(`${providerId} client secret is not configured`);
        }
        return value;
    }

    private readString(data: Record<string, unknown>, key: string) {
        const value = data[key];
        if (typeof value !== 'string' || !value) {
            throw new BadRequestException(`Missing ${key} from OAuth provider response`);
        }
        return value;
    }

    private readOptionalString(data: Record<string, unknown>, key: string) {
        const value = data[key];
        return typeof value === 'string' && value ? value : null;
    }

    private readNumber(data: Record<string, unknown>, key: string) {
        const value = data[key];
        return typeof value === 'number' ? value : null;
    }

    /**
     * Runs one upstream OAuth call and converts transport / HTTP failures
     * into HttpExceptions.
     *
     * Before this, an AxiosError — e.g. Google answering 400 `invalid_grant`
     * to a bogus `code` on `/api/oauth/google/callback` — escaped straight to
     * Nest's ExceptionsHandler and became a 500 "Internal server error"
     * (production, 2026-09-03). GitHub never hit it only because github.com
     * answers 200 with an error body, which `readString` already turns into
     * a BadRequestException.
     *
     * Mapping:
     *  - upstream 4xx other than 401/408/429 -> 400 BadRequestException (the
     *    code / token we presented was rejected; the user has to restart the
     *    flow)
     *  - upstream 401 (OUR client credentials, not the user's grant — a
     *    rejected code is 400 `invalid_grant`, while 401 is `invalid_client`),
     *    408 / 429 (provider timeout or rate limit — our app or the provider
     *    is throttled, the user did nothing wrong), upstream 5xx, or no
     *    response at all (ECONNRESET, timeout, DNS) -> 502
     *    BadGatewayException (the identity provider is the problem, the user
     *    should simply retry; 5xx-keyed alerting keeps seeing the outage)
     *
     * The thrown message names only the provider and the step. The upstream
     * status and a regex-validated bare error code (e.g. `invalid_grant`) are
     * logged at warn level; the free-text body / `error_description` is
     * never logged nor echoed to the client.
     *
     * HttpExceptions raised inside `run` pass through untouched, and non-HTTP
     * errors are rethrown as-is so genuine bugs still surface as 500s.
     */
    private async callUpstream<T>(
        providerId: SocialAuthProviderId,
        step: UpstreamStep,
        run: () => Promise<T>,
    ): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (error instanceof HttpException || !isAxiosError(error)) {
                throw error;
            }

            const { displayName } = SOCIAL_AUTH_PROVIDERS[providerId];
            const status = error.response?.status;
            const errorCode = this.readUpstreamErrorCode(error.response?.data) ?? error.code;

            this.logger.warn(
                `${providerId} OAuth ${step} failed upstream ` +
                    `(status=${status ?? 'none'}, code=${errorCode ?? 'unknown'})`,
            );

            if (this.isClientFaultStatus(status)) {
                throw new BadRequestException(`${displayName} rejected the OAuth ${step}`);
            }

            throw new BadGatewayException(
                `${displayName} did not complete the OAuth ${step} (upstream error)`,
            );
        }
    }

    /**
     * True only for upstream statuses that mean "what we presented was
     * rejected". 408 (provider timed out reading our request) and 429 (our
     * app / the provider is rate-limited) are provider-side conditions, so
     * they deliberately fall through to the 502 branch instead of telling the
     * user to restart a flow that would fail again.
     */
    private isClientFaultStatus(status: number | undefined): boolean {
        return (
            typeof status === 'number' &&
            status >= 400 &&
            status < 500 &&
            !UPSTREAM_NOT_USER_FAULT_STATUSES.has(status)
        );
    }

    /**
     * Extracts the bare OAuth error code (`invalid_grant`, `bad_verification_code`,
     * ...) from an upstream error body, or null. Only a short `[A-Za-z0-9_]`
     * token is accepted so nothing attacker-influenced or multi-line ever
     * reaches the log line.
     */
    private readUpstreamErrorCode(data: unknown): string | null {
        if (!data || typeof data !== 'object') {
            return null;
        }
        const code = (data as Record<string, unknown>).error;
        return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
    }
}

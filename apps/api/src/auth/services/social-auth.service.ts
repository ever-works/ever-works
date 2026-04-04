import { BadRequestException, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AuthProvider } from '../../config/constants';
import { AuthService } from './auth.service';
import {
    getSocialAuthProviderConfig,
    SOCIAL_AUTH_PROVIDERS,
} from '../config/social-auth.providers';
import type { SocialAuthProviderId, SocialAuthUser } from '../types/social-auth.types';

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

interface GitHubEmail {
    email: string;
    primary?: boolean;
    verified?: boolean;
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

@Injectable()
export class SocialAuthService {
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

        const { data } = await firstValueFrom(
            this.httpService.post<Record<string, unknown>>(provider.tokenUrl, params.toString(), {
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }),
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
        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'Ever Works',
        };

        const { data } = await firstValueFrom(
            this.httpService.get<GitHubUser>('https://api.github.com/user', { headers }),
        );

        let email = data.email || null;
        let emailVerified = true;

        if (!email) {
            const emailsResponse = await firstValueFrom(
                this.httpService.get<GitHubEmail[]>('https://api.github.com/user/emails', {
                    headers,
                }),
            );

            const primaryEmail =
                emailsResponse.data.find((item) => item.primary && item.verified) ||
                emailsResponse.data.find((item) => item.primary) ||
                emailsResponse.data.find((item) => item.verified) ||
                emailsResponse.data[0];

            email = primaryEmail?.email || null;
            emailVerified = primaryEmail?.verified !== false;
        }

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
        const { data } = await firstValueFrom(
            this.httpService.get<GoogleUserInfo>(
                'https://openidconnect.googleapis.com/v1/userinfo',
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                },
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
        const { data } = await firstValueFrom(
            this.httpService.get<FacebookUser>('https://graph.facebook.com/me', {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
                params: {
                    fields: 'id,name,email,picture.type(large)',
                },
            }),
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
        const { data } = await firstValueFrom(
            this.httpService.get<LinkedInUserInfo>('https://api.linkedin.com/v2/userinfo', {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }),
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
}

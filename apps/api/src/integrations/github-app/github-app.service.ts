import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { config } from '../../config/constants';
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { firstValueFrom } from 'rxjs';

type GitHubInstallationResponse = {
    id: number;
    target_type?: string;
    account?: {
        login?: string;
        type?: string;
    };
    app_slug?: string;
    suspended_at?: string | null;
};

type GitHubInstallationRepositoriesResponse = {
    repositories?: Array<{
        id: number;
        name: string;
        full_name: string;
        private: boolean;
        default_branch?: string | null;
        owner?: {
            login?: string;
        };
    }>;
};

type GitHubAccessTokenResponse = {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
    token_type?: string;
};

type GitHubUserResponse = {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
    node_id?: string;
};

type GitHubEmailResponse = {
    email: string;
    primary?: boolean;
    verified?: boolean;
};

@Injectable()
export class GitHubAppService {
    constructor(private readonly httpService: HttpService) {}

    getConfiguration() {
        return {
            appId: config.githubApp.appId(),
            clientId: config.githubApp.clientId(),
            slug: config.githubApp.slug(),
            setupUrl: config.githubApp.setupUrl(),
            callbackUrl: config.githubApp.callbackUrl(),
        };
    }

    getUserAuthorizationUrl(state: string): string {
        const params = new URLSearchParams({
            client_id: config.githubApp.clientId() || '',
            redirect_uri: config.githubApp.callbackUrl(),
            state,
        });

        return `https://github.com/login/oauth/authorize?${params.toString()}`;
    }

    async exchangeUserCode(code: string): Promise<GitHubAccessTokenResponse> {
        const params = new URLSearchParams({
            client_id: config.githubApp.clientId() || '',
            client_secret: config.githubApp.clientSecret() || '',
            code,
            redirect_uri: config.githubApp.callbackUrl(),
        });

        const { data } = await firstValueFrom(
            this.httpService.post<GitHubAccessTokenResponse>(
                'https://github.com/login/oauth/access_token',
                params.toString(),
                {
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                },
            ),
        );

        return data;
    }

    async getAuthenticatedGithubUser(accessToken: string) {
        const headers = this.createOAuthHeaders(accessToken);
        const { data } = await firstValueFrom(
            this.httpService.get<GitHubUserResponse>('https://api.github.com/user', { headers }),
        );

        let email = data.email || null;
        let emailVerified = true;

        if (!email) {
            const emailsResponse = await firstValueFrom(
                this.httpService.get<GitHubEmailResponse[]>('https://api.github.com/user/emails', {
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

        return {
            githubUserId: String(data.id),
            login: data.login,
            displayName: data.name || data.login,
            email,
            emailVerified,
            avatarUrl: data.avatar_url || null,
            nodeId: data.node_id || null,
            accessToken,
        };
    }

    async getInstallation(installationId: string): Promise<GitHubInstallationResponse> {
        const jwt = this.createAppJwt();
        const { data } = await firstValueFrom(
            this.httpService.get<GitHubInstallationResponse>(
                `https://api.github.com/app/installations/${installationId}`,
                {
                    headers: this.createAppHeaders(jwt),
                },
            ),
        );

        return data;
    }

    async createInstallationAccessToken(installationId: string): Promise<string> {
        const jwt = this.createAppJwt();
        const { data } = await firstValueFrom(
            this.httpService.post<{ token: string }>(
                `https://api.github.com/app/installations/${installationId}/access_tokens`,
                {},
                {
                    headers: this.createAppHeaders(jwt),
                },
            ),
        );

        return data.token;
    }

    async listInstallationRepositories(installationId: string) {
        const accessToken = await this.createInstallationAccessToken(installationId);
        const { data } = await firstValueFrom(
            this.httpService.get<GitHubInstallationRepositoriesResponse>(
                'https://api.github.com/installation/repositories',
                {
                    headers: this.createOAuthHeaders(accessToken),
                },
            ),
        );

        return data.repositories || [];
    }

    verifyWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
        if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
            return false;
        }

        const secret = config.githubApp.webhookSecret();
        if (!secret) {
            return false;
        }

        const receivedSignature = signatureHeader.slice('sha256='.length);
        const expectedSignature = createHmac('sha256', secret).update(rawBody).digest('hex');

        if (receivedSignature.length !== expectedSignature.length) {
            return false;
        }

        return timingSafeEqual(
            Buffer.from(receivedSignature, 'utf8'),
            Buffer.from(expectedSignature, 'utf8'),
        );
    }

    private createAppJwt(): string {
        const appId = config.githubApp.appId();
        const privateKey = config.githubApp.privateKey();

        if (!appId || !privateKey) {
            throw new Error('GitHub App credentials are not configured');
        }

        const now = Math.floor(Date.now() / 1000);
        const header = this.base64UrlEncode({ alg: 'RS256', typ: 'JWT' });
        const payload = this.base64UrlEncode({
            iat: now - 60,
            exp: now + 9 * 60,
            iss: appId,
        });
        const unsignedToken = `${header}.${payload}`;

        const signer = createSign('RSA-SHA256');
        signer.update(unsignedToken);
        signer.end();

        const signature = signer.sign(privateKey).toString('base64url');
        return `${unsignedToken}.${signature}`;
    }

    private createAppHeaders(jwt: string) {
        return {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'User-Agent': 'Ever Works',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    private createOAuthHeaders(accessToken: string) {
        return {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'Ever Works',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    private base64UrlEncode(value: unknown): string {
        return Buffer.from(JSON.stringify(value)).toString('base64url');
    }
}

import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import {
    createGitHubAppJwt,
    createGitHubAppHeaders,
    createGitHubOAuthHeaders,
    requestGitHubAppInstallationAccessToken,
    verifyGitHubWebhookSignature,
} from '@ever-works/agent/utils';
import { resolveGitHubAccountEmail } from '@src/auth/utils/github-email.utils';
import { config } from '../../config/constants';
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
    total_count?: number;
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
        const headers = createGitHubOAuthHeaders(accessToken);
        const { data } = await firstValueFrom(
            this.httpService.get<GitHubUserResponse>('https://api.github.com/user', { headers }),
        );

        const { email, emailVerified } = await resolveGitHubAccountEmail(
            this.httpService,
            accessToken,
            data.email || null,
        );

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
        const jwt = this.getAppJwt();
        const { data } = await firstValueFrom(
            this.httpService.get<GitHubInstallationResponse>(
                `https://api.github.com/app/installations/${installationId}`,
                {
                    headers: createGitHubAppHeaders(jwt),
                },
            ),
        );

        return data;
    }

    async createInstallationAccessToken(installationId: string): Promise<string> {
        return requestGitHubAppInstallationAccessToken(installationId, this.getCredentials());
    }

    async listInstallationRepositories(installationId: string) {
        const accessToken = await this.createInstallationAccessToken(installationId);
        const headers = createGitHubOAuthHeaders(accessToken);
        const repositories: NonNullable<GitHubInstallationRepositoriesResponse['repositories']> =
            [];
        const perPage = 100;
        let page = 1;

        while (true) {
            const { data } = await firstValueFrom(
                this.httpService.get<GitHubInstallationRepositoriesResponse>(
                    'https://api.github.com/installation/repositories',
                    {
                        headers,
                        params: {
                            per_page: perPage,
                            page,
                        },
                    },
                ),
            );

            const pageRepositories = data.repositories || [];
            repositories.push(...pageRepositories);

            if (pageRepositories.length < perPage) {
                break;
            }

            if (typeof data.total_count === 'number' && repositories.length >= data.total_count) {
                break;
            }

            page += 1;
        }

        return repositories;
    }

    verifyWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
        const secret = config.githubApp.webhookSecret();
        if (!secret) {
            return false;
        }

        return verifyGitHubWebhookSignature(rawBody, secret, signatureHeader);
    }

    private getAppJwt(): string {
        const credentials = this.getCredentials();
        return createGitHubAppJwt(credentials);
    }

    private getCredentials() {
        const appId = config.githubApp.appId();
        const privateKey = config.githubApp.privateKey();

        if (!appId || !privateKey) {
            throw new Error('GitHub App credentials are not configured');
        }

        return {
            appId,
            privateKey,
        };
    }
}

import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

export type GitHubAppCredentials = {
    appId: string;
    privateKey: string;
};

export type GitHubAppInstallationAccessToken = {
    token: string;
    expiresAt: string | null;
};

export const createGitHubAppJwt = ({ appId, privateKey }: GitHubAppCredentials): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
        JSON.stringify({
            iat: now - 60,
            exp: now + 9 * 60,
            iss: appId,
        }),
    ).toString('base64url');
    const unsignedToken = `${header}.${payload}`;

    const signer = createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();

    const signature = signer.sign(privateKey).toString('base64url');
    return `${unsignedToken}.${signature}`;
};

export const createGitHubAppHeaders = (jwt: string) => ({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${jwt}`,
    'User-Agent': 'Ever Works',
    'X-GitHub-Api-Version': '2022-11-28',
});

export const createGitHubOAuthHeaders = (accessToken: string) => ({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'Ever Works',
    'X-GitHub-Api-Version': '2022-11-28',
});

export const requestGitHubAppInstallationAccessTokenDetails = async (
    installationId: string,
    credentials: GitHubAppCredentials,
): Promise<GitHubAppInstallationAccessToken> => {
    const jwt = createGitHubAppJwt(credentials);
    const response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
            method: 'POST',
            headers: createGitHubAppHeaders(jwt),
        },
    );

    if (!response.ok) {
        throw new Error(
            `Failed to create GitHub App installation token: ${response.status} ${response.statusText}`,
        );
    }

    const data = (await response.json()) as { token?: string; expires_at?: string | null };
    if (!data.token) {
        throw new Error('GitHub App installation token response did not include a token');
    }

    return {
        token: data.token,
        expiresAt: data.expires_at ?? null,
    };
};

export const requestGitHubAppInstallationAccessToken = async (
    installationId: string,
    credentials: GitHubAppCredentials,
): Promise<string> => {
    const data = await requestGitHubAppInstallationAccessTokenDetails(installationId, credentials);
    return data.token;
};

export const verifyGitHubWebhookSignature = (
    rawBody: string,
    secret: string,
    signatureHeader?: string,
): boolean => {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
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
};

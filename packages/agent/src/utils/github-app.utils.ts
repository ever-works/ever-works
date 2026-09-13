import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

export type GitHubAppCredentials = {
    appId: string;
    privateKey: string;
};

export type GitHubAppInstallationAccessToken = {
    token: string;
    expiresAt: string | null;
};

/**
 * Mint a GitHub App JWT for authenticating as the App itself
 * (subsequent step exchanges it for a per-installation token).
 *
 * **Two "magic numbers" worth not changing without reading this:**
 *
 *   - **`iat: now - 60`** backdates issuance by 60 seconds. Without
 *     this, any clock skew where THIS server is slightly ahead of
 *     GitHub's clock causes GitHub to reject the JWT with
 *     "iat must be in the past". 60s covers typical NTP drift.
 *   - **`exp: now + 9 * 60`** = 9-minute expiry. GitHub's hard
 *     ceiling is 10 minutes; 9 is the documented safety margin so
 *     a clock-skew + network latency cocktail can't push `exp` past
 *     the ceiling at validation time.
 *
 * RS256 is mandatory for GitHub Apps — don't switch algorithm.
 * `base64url` (NOT plain base64) is also required.
 */
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

/**
 * Narrowing applied to ONE installation token (self-build slice AM).
 *
 * Every mint in this repository before that slice sent an EMPTY body, and
 * an empty body means "every repository in the installation, with every
 * permission the App holds". That is fine for the read-shaped callers
 * (analyze, list, clone) and is precisely the wrong shape for a WRITE
 * credential handed to an unattended machine: a token minted so a node
 * can push one Task branch could write every repository the owner ever
 * installed the App on.
 *
 * Both fields are OPTIONAL and both are omitted by every pre-existing
 * caller, so their behaviour is byte-for-byte unchanged.
 */
export type GitHubAppInstallationTokenScope = {
    /**
     * GitHub's NUMERIC repository ids. They must come from the platform's
     * own installation snapshot (`github_app_installation_repositories`),
     * never from a caller-supplied name: the whole point of the narrowing
     * is that the set is decided by platform state.
     */
    repositoryIds?: readonly (string | number)[];
    /** e.g. `{ contents: 'write' }`. Anything omitted is NOT granted. */
    permissions?: Readonly<Record<string, string>>;
};

export const requestGitHubAppInstallationAccessTokenDetails = async (
    installationId: string,
    credentials: GitHubAppCredentials,
    // Appended LAST and optional: every existing call site keeps its arity
    // and its (unscoped) behaviour.
    scope?: GitHubAppInstallationTokenScope,
): Promise<GitHubAppInstallationAccessToken> => {
    if (!/^[A-Za-z0-9_-]+$/.test(installationId)) {
        throw new Error(
            `Invalid installationId: must contain only alphanumeric characters, hyphens, or underscores`,
        );
    }
    const jwt = createGitHubAppJwt(credentials);
    const body: Record<string, unknown> = {};
    if (scope?.repositoryIds && scope.repositoryIds.length > 0) {
        const repositoryIds = scope.repositoryIds.map((value) => {
            // DIGITS ONLY, not `parseInt`: `parseInt('556677abc')` and
            // `parseInt('1e30')` both succeed and both give a DIFFERENT
            // repository than the caller named, which is a token scoped to
            // the wrong thing rather than a refusal.
            const text = String(value).trim();
            const numeric =
                typeof value === 'number'
                    ? value
                    : /^[0-9]+$/.test(text)
                      ? Number(text)
                      : Number.NaN;
            if (!Number.isSafeInteger(numeric) || numeric <= 0) {
                // REFUSE rather than drop. A silently shortened id list
                // produces a token that is valid for fewer repositories
                // than the caller asked for, and the failure then lands at
                // the push of whichever one fell off the end.
                throw new Error('Invalid GitHub repository id in installation token scope');
            }
            return numeric;
        });
        body.repository_ids = repositoryIds;
    }
    if (scope?.permissions && Object.keys(scope.permissions).length > 0) {
        body.permissions = { ...scope.permissions };
    }
    const hasBody = Object.keys(body).length > 0;
    const response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
            method: 'POST',
            headers: hasBody
                ? { ...createGitHubAppHeaders(jwt), 'Content-Type': 'application/json' }
                : createGitHubAppHeaders(jwt),
            ...(hasBody ? { body: JSON.stringify(body) } : {}),
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

/**
 * Verify a GitHub webhook delivery's `X-Hub-Signature-256` against
 * the shared secret using HMAC-SHA256.
 *
 * **Security invariants worth NOT regressing on:**
 *
 *   - **`sha256=` prefix required.** Returns `false` for missing
 *     or `sha1=`-prefixed signatures (GitHub's legacy SHA-1
 *     signature was deprecated; never accept it).
 *   - **Length check before `timingSafeEqual`** — the Node API
 *     throws on mismatched-length buffers, so the early return
 *     keeps the call total. The length check itself isn't a
 *     timing leak (length of a SHA-256 hex digest is constant).
 *   - **`timingSafeEqual` on raw bytes** — protects against
 *     byte-by-byte timing attacks on the signature comparison.
 *     Don't replace with `===` even "for clarity".
 *
 * **`rawBody` must be the EXACT bytes** GitHub sent (no JSON
 * re-serialisation). Express/Nest body parsers that pretty-print
 * or normalise whitespace will break verification — capture the
 * raw body in middleware before parsing.
 */
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

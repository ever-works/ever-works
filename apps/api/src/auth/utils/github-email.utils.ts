import { HttpService } from '@nestjs/axios';
import { createGitHubOAuthHeaders } from '@ever-works/agent/utils';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

type GitHubEmailResponse = {
    email: string;
    primary?: boolean;
    verified?: boolean;
};

/**
 * Status codes GitHub answers `GET /user/emails` with when the token is valid but
 * may not read the account's email addresses:
 *
 *  - a GitHub **App** user-to-server token whose App lacks the account permission
 *    "Email addresses: read" (403 "Resource not accessible by integration", or 404);
 *  - an OAuth App token granted without the `user:email` scope (404).
 *
 * 401 (bad/expired token), 5xx, rate limiting and network failures are NOT treated
 * as a missing permission — those still throw, so a genuinely broken or throttled
 * upstream is never mistaken for "no permission".
 */
const MISSING_EMAIL_PERMISSION_STATUSES: ReadonlySet<number> = new Set([403, 404]);

export type ResolveGitHubAccountEmailOptions = {
    /**
     * When true, a 403/404 from `GET /user/emails` degrades to the `/user` profile
     * email, marked UNVERIFIED, instead of throwing.
     *
     * Opt-in, and only the GitHub App onboarding path opts in: it resolves the local
     * user by GitHub user id (App user link → `github` auth account) before any
     * email lookup, and refuses to link an unverified email to an existing user.
     * The OAuth-App sign-in path requests `user:email` explicitly and resolves the
     * local user by email first, so it keeps failing loudly on a missing scope.
     */
    allowMissingEmailPermission?: boolean;
    /** Receives one warning naming the missing permission when the fallback is taken. */
    logger?: { warn(message: string): void };
};

/**
 * The status of a GitHub answer that means "this token may not read the email
 * addresses", or undefined for anything else. A 403 that carries GitHub's
 * rate-limit markers (`x-ratelimit-remaining: 0`, or `retry-after` for a
 * secondary limit) is throttling, not a missing permission, so it is excluded.
 */
function missingEmailPermissionStatus(error: unknown): number | undefined {
    if (!isAxiosError(error) || !error.response) {
        return undefined;
    }
    const { status, headers } = error.response;
    if (!MISSING_EMAIL_PERMISSION_STATUSES.has(status)) {
        return undefined;
    }
    const remaining = headers?.['x-ratelimit-remaining'];
    if (status === 403 && (String(remaining) === '0' || headers?.['retry-after'] != null)) {
        return undefined;
    }
    return status;
}

export async function resolveGitHubAccountEmail(
    httpService: HttpService,
    accessToken: string,
    profileEmail?: string | null,
    options: ResolveGitHubAccountEmailOptions = {},
): Promise<{ email: string | null; emailVerified: boolean }> {
    const headers = createGitHubOAuthHeaders(accessToken);
    let emails: GitHubEmailResponse[];
    try {
        const emailsResponse = await firstValueFrom(
            httpService.get<GitHubEmailResponse[]>('https://api.github.com/user/emails', {
                headers,
            }),
        );
        emails = emailsResponse.data || [];
    } catch (error) {
        const status = missingEmailPermissionStatus(error);
        if (!options.allowMissingEmailPermission || status === undefined) {
            throw error;
        }

        options.logger?.warn(
            `GitHub GET /user/emails answered ${status}: the token cannot read the ` +
                "account's email addresses. Grant the GitHub App the account permission " +
                '"Email addresses: read" so verified emails can be used for account linking. ' +
                'Falling back to the public profile email, treated as unverified.',
        );

        // The profile email is whatever the user chose to make public; without
        // /user/emails we cannot see its verification state, so it is NEVER
        // reported as verified (it can create a fresh account but never link to
        // an existing one).
        return {
            email: profileEmail?.trim() || null,
            emailVerified: false,
        };
    }

    const normalizedProfileEmail = profileEmail?.trim().toLowerCase() || null;
    const matchingProfileEmail = normalizedProfileEmail
        ? emails.find((item) => item.email.trim().toLowerCase() === normalizedProfileEmail)
        : null;
    const preferredEmail =
        (matchingProfileEmail?.verified ? matchingProfileEmail : null) ||
        emails.find((item) => item.primary && item.verified) ||
        emails.find((item) => item.verified) ||
        matchingProfileEmail ||
        emails.find((item) => item.primary) ||
        emails[0] ||
        null;

    return {
        email: preferredEmail?.email || profileEmail || null,
        emailVerified: preferredEmail?.verified === true,
    };
}

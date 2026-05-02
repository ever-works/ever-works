import { HttpService } from '@nestjs/axios';
import { createGitHubOAuthHeaders } from '@ever-works/agent/utils';
import { firstValueFrom } from 'rxjs';

type GitHubEmailResponse = {
    email: string;
    primary?: boolean;
    verified?: boolean;
};

export async function resolveGitHubAccountEmail(
    httpService: HttpService,
    accessToken: string,
    profileEmail?: string | null,
): Promise<{ email: string | null; emailVerified: boolean }> {
    const headers = createGitHubOAuthHeaders(accessToken);
    const emailsResponse = await firstValueFrom(
        httpService.get<GitHubEmailResponse[]>('https://api.github.com/user/emails', {
            headers,
        }),
    );

    const emails = emailsResponse.data || [];
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

import 'server-only';

import { API_URL, ROUTES, WEB_URL } from '@/lib/constants';

type FreshProfileResponse = {
    oauthTokens?: Array<{
        provider: string;
    }>;
};

export async function shouldPromptGithubConnect(accessToken: string): Promise<boolean> {
    try {
        const response = await fetch(`${API_URL}/auth/profile/fresh`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            cache: 'no-store',
            next: { revalidate: 0 },
        });

        if (!response.ok) {
            return false;
        }

        const profile = (await response.json()) as FreshProfileResponse;
        return !profile.oauthTokens?.some((token) => token.provider === 'github');
    } catch {
        return false;
    }
}

export function addConnectGithubParam(href: string): string {
    const url = new URL(href, WEB_URL);
    url.searchParams.set('connectGithub', '1');

    return `${url.pathname}${url.search}`;
}

export function isDashboardHref(href: string): boolean {
    return href === ROUTES.DASHBOARD || href.startsWith(`${ROUTES.DASHBOARD}?`);
}

import 'server-only';
import { API_URL, WEB_URL } from '../constants';
import { headers } from 'next/headers';
import { getBetterAuthCookieHeader } from '../auth/cookies';
import { getTranslations } from 'next-intl/server';

export async function handleServerError(error: unknown): Promise<never> {
    console.error('Server API Error:', error);
    const t = await getTranslations('api.errors');

    if (error instanceof Error) {
        if (error.message.includes('Unauthorized')) {
            throw new Error(t('unauthorized'));
        }

        throw new Error(t('serverError', { message: error.message }));
    }

    throw new Error(t('unexpected'));
}

export async function getFrontendUrl(): Promise<string> {
    const headersList = await headers();
    const host = headersList.get('x-forwarded-host') || headersList.get('host');
    const protocol = headersList.get('x-forwarded-proto') || 'https';

    if (host) {
        return `${protocol}://${host}`;
    }

    // Fallback to environment variable or localhost
    return WEB_URL;
}

interface ServerFetchOptions extends RequestInit {
    rawResponse?: boolean;
}

export async function serverFetch<T>(
    endpoint: string,
    options: ServerFetchOptions = {},
): Promise<T> {
    const frontendUrl = await getFrontendUrl();
    const t = await getTranslations('api.errors');
    const { rawResponse, ...fetchOptions } = options;

    const doFetch = async (baCookieHeader?: string) => {
        const reqHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Frontend-URL': frontendUrl,
            ...((fetchOptions.headers as Record<string, string>) || {}),
        };

        if (baCookieHeader) {
            // Forward BetterAuth session cookies to the API
            reqHeaders['Cookie'] = baCookieHeader;
        }

        return fetch(`${API_URL}${endpoint}`, {
            ...fetchOptions,
            headers: reqHeaders,
            cache: 'no-store',
            next: { revalidate: 0 },
        });
    };

    const baCookies = await getBetterAuthCookieHeader();
    const response = await doFetch(baCookies);

    // Return raw response for streaming
    if (rawResponse) {
        return response as T;
    }

    if (!response.ok) {
        let errorMessage: string | null = null;
        try {
            const errorData = await response.json();

            // Only log unexpected errors — 404s are expected for missing resources
            if (response.status !== 404) {
                console.error('API Error:', errorData);
            }

            if (errorData?.message) {
                errorMessage = Array.isArray(errorData.message)
                    ? errorData.message.join(', ')
                    : errorData.message;

                if (Array.isArray(errorData.errors) && errorData.errors.length > 0) {
                    errorMessage += ': ' + errorData.errors.join(', ');
                }
            } else if (errorData.error?.message) {
                errorMessage = errorData.error.message;
            } else if (typeof errorData.error === 'string') {
                errorMessage = errorData.error;
            }
        } catch (e) {
            errorMessage = await response.text().catch(() => null);
            errorMessage = errorMessage?.trim() || null;
        }

        // Handle authentication errors
        if (response.status === 401) {
            throw new Error(errorMessage || t('unauthorizedLogin'));
        }

        // Handle forbidden errors
        if (response.status === 403) {
            throw new Error(errorMessage || t('forbidden'));
        }

        const apiErro = t('apiError', {
            status: response.status,
            statusText: response.statusText,
        });

        throw new Error(errorMessage || apiErro);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        return text as T;
    }
}

// Type-safe server-side mutations (for use in server actions)
export async function serverMutation<T>({
    endpoint,
    data,
    method = 'POST',
    wrapInData = false,
    headers,
}: {
    endpoint: string;
    data: any;
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    wrapInData: boolean;
    headers?: Record<string, string>;
}): Promise<T> {
    return serverFetch<T>(endpoint, {
        method,
        headers,
        body: JSON.stringify(wrapInData ? { data } : data),
    });
}

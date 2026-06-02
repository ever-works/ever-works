import 'server-only';
import { ALLOWED_REDIRECT_URLS, API_URL, WEB_URL } from '../constants';
import { headers } from 'next/headers';
import { getAuthAccessCookie } from '../auth/cookies';
import { getTranslations } from 'next-intl/server';

export class ApiResponseError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly code?: string,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'ApiResponseError';
    }
}

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

// Security: `x-forwarded-host` / `x-forwarded-proto` are attacker-controlled
// (a client can send `x-forwarded-host: evil.com` directly, or a misconfigured
// proxy can pass it through). The resolved value is forwarded to the backend
// API as the `X-Frontend-URL` header on every server-side call, so an
// un-validated host enables host-header injection (open-redirect / phishing if
// the API ever uses it to build email/OAuth/redirect links). Only honor a
// forwarded host when it resolves to an allowlisted origin; otherwise fall back
// to the canonical `WEB_URL`. Host matching mirrors `isRelativeOrAllowedRedirectHost`
// in lib/auth/redirect.ts and lib/utils/url.ts (exact match + leading `*.` wildcard).
function isAllowedFrontendHost(hostname: string): boolean {
    const cleanHostname = hostname.toLowerCase();

    return ALLOWED_REDIRECT_URLS.some((allowed) => {
        const cleanAllowed = allowed
            .replace(/^https?:\/\//, '')
            .toLowerCase()
            .trim();

        if (cleanAllowed.startsWith('*.')) {
            const domain = cleanAllowed.slice(2);
            return cleanHostname !== domain && cleanHostname.endsWith('.' + domain);
        }

        return cleanHostname === cleanAllowed;
    });
}

export async function getFrontendUrl(): Promise<string> {
    const headersList = await headers();
    const host = headersList.get('x-forwarded-host') || headersList.get('host');
    // Security: constrain the protocol to http(s); never echo back an
    // attacker-supplied scheme (e.g. `x-forwarded-proto: file`).
    const protocol = headersList.get('x-forwarded-proto') === 'http' ? 'http' : 'https';

    if (host) {
        const candidate = `${protocol}://${host}`;

        // Security: validate the forwarded host against the allowlist before
        // trusting it; fall back to the canonical WEB_URL on any mismatch or
        // malformed value (the port is ignored, matching the allowlist logic
        // used across the auth redirect helpers).
        try {
            if (isAllowedFrontendHost(new URL(candidate).hostname)) {
                return candidate;
            }
        } catch {
            // malformed host — fall through to WEB_URL
        }
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

    const doFetch = async (authToken?: string) => {
        const reqHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Frontend-URL': frontendUrl,
            ...((fetchOptions.headers as Record<string, string>) || {}),
        };

        if (authToken) {
            reqHeaders['Authorization'] = `Bearer ${authToken}`;
        }

        return fetch(`${API_URL}${endpoint}`, {
            ...fetchOptions,
            headers: reqHeaders,
            cache: 'no-store',
            next: { revalidate: 0 },
        });
    };

    const token = await getAuthAccessCookie();
    const response = await doFetch(token);

    // Return raw response for streaming
    if (rawResponse) {
        return response as T;
    }

    if (!response.ok) {
        let errorMessage: string | null = null;
        let errorCode: string | undefined;
        let errorDetails: Record<string, unknown> | undefined;
        try {
            const errorData = await response.json();
            const hasStructuredError =
                errorData &&
                typeof errorData === 'object' &&
                !Array.isArray(errorData) &&
                Object.keys(errorData).length > 0;

            if (hasStructuredError) {
                errorDetails = errorData as Record<string, unknown>;
            }

            // Only log unexpected errors — 404s are expected for missing resources
            if (response.status !== 404 && hasStructuredError) {
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
            } else if (!hasStructuredError) {
                errorMessage = `${response.status} ${response.statusText}`.trim();
            }

            if (typeof errorData?.code === 'string') {
                errorCode = errorData.code;
            } else if (typeof errorData?.error?.code === 'string') {
                errorCode = errorData.error.code;
            }
        } catch (e) {
            errorMessage = await response.text().catch(() => null);
            errorMessage = errorMessage?.trim() || null;
        }

        // Handle authentication errors
        if (response.status === 401) {
            throw new ApiResponseError(
                errorMessage || t('unauthorizedLogin'),
                response.status,
                errorCode,
                errorDetails,
            );
        }

        // Handle forbidden errors
        if (response.status === 403) {
            throw new ApiResponseError(
                errorMessage || t('forbidden'),
                response.status,
                errorCode,
                errorDetails,
            );
        }

        const apiErro = t('apiError', {
            status: response.status,
            statusText: response.statusText,
        });

        throw new ApiResponseError(
            errorMessage || apiErro,
            response.status,
            errorCode,
            errorDetails,
        );
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

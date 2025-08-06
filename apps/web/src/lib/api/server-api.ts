import 'server-only';
import { API_URL } from '../constants';
import { headers } from 'next/headers';
import { getAuthCookie } from '../auth/cookies';
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
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export async function serverFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = await getAuthCookie();
    const frontendUrl = await getFrontendUrl();
    const t = await getTranslations('api.errors');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Frontend-URL': frontendUrl,
        ...((options.headers as Record<string, string>) || {}),
    };

    // Add authentication header if token exists
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_URL}${endpoint}`, {
        ...options,
        headers,
        // Enable caching for GET requests by default
        // next: {
        //     revalidate: options.method === "GET" ? 3600 : 0, // Cache for 1 hour
        //     tags: [endpoint.split("/")[1] || "api"], // Tag based on resource type
        // },
        cache: 'no-store',
        next: { revalidate: 0 },
    });

    if (!response.ok) {
        let errorMessage: string | null = null;
        try {
            const errorData = await response.json();

            if (errorData?.message) {
                errorMessage = Array.isArray(errorData.message)
                    ? errorData.message.join(', ')
                    : errorData.message;
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

    try {
        return response.json();
    } catch (error) {
        return response.text() as T;
    }
}

// Type-safe server-side mutations (for use in server actions)
export async function serverMutation<T>({
    endpoint,
    data,
    method = 'POST',
    wrapInData = false,
}: {
    endpoint: string;
    data: any;
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    wrapInData: boolean;
}): Promise<T> {
    return serverFetch<T>(endpoint, {
        method,
        body: JSON.stringify(wrapInData ? { data } : data),
    });
}

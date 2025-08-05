import { API_URL } from '../constants';
import { headers } from 'next/headers';
import { getAuthCookie } from '../auth/cookies';

export function handleServerError(error: unknown): never {
    console.error('Server API Error:', error);

    if (error instanceof Error) {
        if (error.message.includes('Unauthorized')) {
            throw new Error('You are not authorized to perform this action');
        }

        throw new Error(`Server error: ${error.message}`);
    }

    throw new Error('Unexpected server error occurred.');
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
        // Handle authentication errors
        if (response.status === 401) {
            throw new Error('Unauthorized: Please log in again.');
        }

        // Handle forbidden errors
        if (response.status === 403) {
            let errorMessage = 'Forbidden: You do not have permission to perform this action.';

            try {
                const errorData = await response.json();
                if (errorData.error?.message) {
                    errorMessage = errorData.error.message;
                } else if (typeof errorData.error === 'string') {
                    errorMessage = errorData.error;
                }
            } catch (e) {
                // Use default message
            }

            throw new Error(errorMessage);
        }

        // Try to get error message from response body
        let errorMessage = `API Error: ${response.status} ${response.statusText}`;
        try {
            const errorData = await response.json();
            if (errorData.error?.message) {
                errorMessage = errorData.error.message;
            } else if (errorData.message) {
                errorMessage = errorData.message;
            }
        } catch (e) {
            // If we can't parse the error response, use the default message
        }

        throw new Error(errorMessage);
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

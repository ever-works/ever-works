import { Injectable } from '@nestjs/common';
import superjson from 'superjson';
import { config } from '@ever-works/agent/config';
import { DirectoryContextResponse } from '@ever-works/agent/tasks';

@Injectable()
export class TriggerInternalApiClient {
    private readonly baseUrl: string;
    private readonly secret: string;

    constructor() {
        this.baseUrl = config.trigger.getInternalBaseUrl() || '';
        this.secret = config.trigger.getInternalSecret() || '';

        if (!this.baseUrl) {
            throw new Error('TRIGGER_INTERNAL_API_URL is not configured');
        }

        if (!this.secret) {
            throw new Error('TRIGGER_INTERNAL_SECRET is not configured');
        }
    }

    async fetchDirectoryContext(
        directoryId: string,
        userId: string,
    ): Promise<DirectoryContextResponse> {
        const searchParams = new URLSearchParams({ userId });

        return this.request<DirectoryContextResponse>({
            method: 'GET',
            path: `/directories/${directoryId}/context?${searchParams.toString()}`,
        });
    }

    /**
     * Forward a method call to a named injectable on the API side.
     * Args are passed as a SuperJSON envelope; the result is SuperJSON-deserialized.
     */
    async callRemote(
        name: string,
        method: string,
        args: { json: unknown; meta?: unknown },
    ): Promise<unknown> {
        const response = await this.request<{ result: { json: unknown; meta?: unknown } }>({
            method: 'POST',
            path: '/remote/call',
            body: { name, method, args },
        });

        return response.result ? superjson.deserialize(response.result as any) : undefined;
    }

    private async request<T>({
        method,
        path,
        body,
    }: {
        method: string;
        path: string;
        body?: unknown;
    }): Promise<T> {
        const url = this.composeUrl(path);
        const maxRetries = 3;
        const baseDelayMs = 500;

        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }

            let response: Response;

            try {
                response = await fetch(url, {
                    method,
                    headers: {
                        'content-type': 'application/json',
                        'x-trigger-secret': this.secret,
                    },
                    body: body ? JSON.stringify(body) : undefined,
                });
            } catch (networkError) {
                lastError =
                    networkError instanceof Error ? networkError : new Error(String(networkError));

                if (attempt < maxRetries) {
                    continue;
                }

                throw lastError;
            }

            if (response.ok) {
                if (response.status === 204) {
                    return undefined as T;
                }

                const text = await response.text();

                return text ? (JSON.parse(text) as T) : (undefined as T);
            }

            const text = await response.text();
            lastError = new Error(
                `Trigger internal API request failed (${response.status}): ${text}`,
            );

            // Only retry on 5xx server errors
            if (response.status < 500 || attempt >= maxRetries) {
                throw lastError;
            }
        }

        throw lastError ?? new Error('Trigger internal API request failed after retries');
    }

    private composeUrl(path: string): string {
        const trimmedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
        const trimmedPath = path.startsWith('/') ? path.slice(1) : path;

        return `${trimmedBase}/${trimmedPath}`;
    }
}

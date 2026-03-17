declare module 'check-links' {
    export type CheckLinkStatus = 'alive' | 'dead' | 'invalid';

    export interface CheckLinkResult {
        status: CheckLinkStatus;
        statusCode?: number;
    }

    export interface CheckLinksOptions {
        concurrency?: number;
        timeout?: {
            request?: number;
        };
        retry?: {
            limit?: number;
        };
    }

    export default function checkLinks(
        urls: string[],
        options?: CheckLinksOptions,
    ): Promise<Record<string, CheckLinkResult>>;
}

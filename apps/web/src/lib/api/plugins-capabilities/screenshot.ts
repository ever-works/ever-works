import 'server-only';
import type { ProviderOption } from '../types-only';
import { serverFetch, serverMutation } from '../server-api';

export interface CheckAvailabilityResponse {
    status: 'success' | 'error';
    available: boolean;
    providers: ProviderOption[];
    activeProvider?: ProviderOption | null;
}

export interface CaptureScreenshotDto {
    url: string;
    providerOverride?: string;
    workId?: string;
    viewportWidth?: number;
    viewportHeight?: number;
    format?: 'png' | 'jpg' | 'webp';
    fullPage?: boolean;
    delay?: number;
    blockAds?: boolean;
    blockTrackers?: boolean;
    blockCookieBanners?: boolean;
}

export interface CaptureScreenshotResponse {
    status: 'success' | 'error';
    imageUrl?: string;
    cacheUrl?: string;
    imageBase64?: string;
    message?: string;
}

export interface GetScreenshotUrlResponse {
    status: 'success' | 'error';
    imageUrl?: string;
    message?: string;
}

export const screenshotAPI = {
    checkAvailability: async (workId?: string) => {
        const query = workId ? `?workId=${encodeURIComponent(workId)}` : '';
        return serverFetch<CheckAvailabilityResponse>(`/screenshot/check-availability${query}`);
    },

    capture: async (data: CaptureScreenshotDto) => {
        return serverMutation<CaptureScreenshotResponse>({
            endpoint: '/screenshot/capture',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    getScreenshotUrl: async (data: CaptureScreenshotDto) => {
        return serverMutation<GetScreenshotUrlResponse>({
            endpoint: '/screenshot/get-url',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
};

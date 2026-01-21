import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export interface ValidateCredentialsResponse {
    status: 'success' | 'error';
    valid: boolean;
    message?: string;
}

export interface CheckAvailabilityResponse {
    status: 'success' | 'error';
    available: boolean;
    hasGlobalKey: boolean;
    hasUserKey: boolean;
}

export interface CaptureScreenshotDto {
    url: string;
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
    imageBase64?: string;
    message?: string;
}

export interface GetScreenshotUrlResponse {
    status: 'success' | 'error';
    imageUrl?: string;
    message?: string;
}

export const screenshotAPI = {
    /**
     * Validate a ScreenshotOne access key.
     */
    validateCredentials: async (accessKey: string) => {
        return serverMutation<ValidateCredentialsResponse>({
            endpoint: '/screenshot/validate-credentials',
            data: { accessKey },
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Check if the screenshot service is available for the current user.
     */
    checkAvailability: async () => {
        return serverFetch<CheckAvailabilityResponse>('/screenshot/check-availability');
    },

    /**
     * Capture a screenshot of a URL.
     */
    capture: async (data: CaptureScreenshotDto) => {
        return serverMutation<CaptureScreenshotResponse>({
            endpoint: '/screenshot/capture',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Get the direct URL for a screenshot without capturing it.
     */
    getScreenshotUrl: async (data: CaptureScreenshotDto) => {
        return serverMutation<GetScreenshotUrlResponse>({
            endpoint: '/screenshot/get-url',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
};

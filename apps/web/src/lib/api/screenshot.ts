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
    cacheUrl?: string;
    imageBase64?: string;
    message?: string;
}

export interface GetScreenshotUrlResponse {
    status: 'success' | 'error';
    imageUrl?: string;
    message?: string;
}

export interface SmartImagePreviewDto {
    url: string;
    domainType?: 'software' | 'ecommerce' | 'services' | 'general';
    itemName?: string;
}

export interface SmartImagePreviewResponse {
    status: 'success' | 'error';
    primaryImage: string | null;
    source: 'screenshot' | 'scraped';
    confidence?: number;
    error?: string;
}

export interface BulkCaptureImagesDto {
    itemSlugs?: string[];
    mode: 'missing' | 'all';
}

export interface BulkCaptureResult {
    itemSlug?: string;
    itemName?: string;
    primaryImage: string | null;
    source: 'screenshot' | 'scraped';
    confidence?: number;
    error?: string;
}

export interface BulkCaptureImagesResponse {
    status: 'success' | 'partial' | 'error';
    results: BulkCaptureResult[];
    totalProcessed: number;
    successCount: number;
    errorCount: number;
    message?: string;
}

export const screenshotAPI = {
    /**
     * Validate ScreenshotOne access key and optional secret key.
     */
    validateCredentials: async (accessKey: string, secretKey?: string) => {
        return serverMutation<ValidateCredentialsResponse>({
            endpoint: '/screenshot/validate-credentials',
            data: { accessKey, secretKey },
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

    /**
     * Get a smart image for a URL based on domain type.
     * Routes to product image extraction for ecommerce, screenshots for software.
     */
    getSmartImage: async (data: SmartImagePreviewDto) => {
        return serverMutation<SmartImagePreviewResponse>({
            endpoint: '/screenshot/smart-preview',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Bulk capture images for multiple items in a directory.
     */
    bulkCaptureImages: async (directoryId: string, data: BulkCaptureImagesDto) => {
        return serverMutation<BulkCaptureImagesResponse>({
            endpoint: `/directories/${directoryId}/bulk-capture-images`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
};

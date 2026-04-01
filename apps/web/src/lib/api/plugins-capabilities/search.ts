import 'server-only';
import { serverFetch, serverMutation } from '../server-api';

export interface SearchCheckAvailabilityResponse {
    status: 'success' | 'error';
    available: boolean;
    activeProvider: { id: string; name: string } | null;
    message?: string;
}

export interface SearchRequestDto {
    query: string;
    maxResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
}

export interface SearchResultItem {
    title: string;
    url: string;
    score: number;
    publishedDate?: string;
}

export interface SearchResponse {
    status: 'success' | 'error';
    results: SearchResultItem[];
    message?: string;
}

export const searchAPI = {
    checkAvailability: async () => {
        return serverFetch<SearchCheckAvailabilityResponse>('/search/check-availability');
    },

    search: async (data: SearchRequestDto) => {
        return serverMutation<SearchResponse>({
            endpoint: '/search',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
};

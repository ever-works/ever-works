'use client';

import { createContext, useContext } from 'react';
import type { ProviderOption } from '@/lib/api/types-only';

interface ItemsContextType {
    workId: string;
    canEdit: boolean;
    workWebsite?: string;
    screenshotAvailable: boolean;
    screenshotProviders: ProviderOption[];
    activeScreenshotProvider?: ProviderOption | null;
}

const ItemsContext = createContext<ItemsContextType>({
    workId: '',
    canEdit: false,
    screenshotAvailable: false,
    screenshotProviders: [],
    activeScreenshotProvider: null,
});

export const ItemsProvider = ItemsContext.Provider;

export function useItemsContext() {
    return useContext(ItemsContext);
}

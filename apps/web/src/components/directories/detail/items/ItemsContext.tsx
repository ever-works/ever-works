'use client';

import { createContext, useContext } from 'react';
import type { ProviderOption } from '@/lib/api/types-only';

interface ItemsContextType {
    directoryId: string;
    canEdit: boolean;
    directoryWebsite?: string;
    screenshotAvailable: boolean;
    screenshotProviders: ProviderOption[];
    activeScreenshotProvider?: ProviderOption | null;
}

const ItemsContext = createContext<ItemsContextType>({
    directoryId: '',
    canEdit: false,
    screenshotAvailable: false,
    screenshotProviders: [],
    activeScreenshotProvider: null,
});

export const ItemsProvider = ItemsContext.Provider;

export function useItemsContext() {
    return useContext(ItemsContext);
}

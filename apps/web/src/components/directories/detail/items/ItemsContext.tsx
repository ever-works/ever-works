'use client';

import { createContext, useContext } from 'react';

interface ItemsContextType {
    directoryId: string;
    canEdit: boolean;
    directoryWebsite?: string;
    screenshotAvailable: boolean;
}

const ItemsContext = createContext<ItemsContextType>({
    directoryId: '',
    canEdit: false,
    screenshotAvailable: false,
});

export const ItemsProvider = ItemsContext.Provider;

export function useItemsContext() {
    return useContext(ItemsContext);
}

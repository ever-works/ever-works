import { ItemData } from "./types";

type GeneratedItemWithSlug = Partial<ItemData>;

export function deduplicateByField(items: GeneratedItemWithSlug[], field: keyof GeneratedItemWithSlug) {
    const map = new Map<string, GeneratedItemWithSlug>();
    for (const item of items) {
        map.set(item[field] as string, item);
    }
    return Array.from(map.values());
}

/**
 * Shows array difference. Useful for checking which items were excluded.
 *
 * @param bigger The larger array (usually input array for deduplication).
 * @param smaler The potentially smaller array (usually output of deduplication).
 * @param key The key to compare items by.
 * @returns An array of excluded items.
 */
export function arrayDiff<T extends object>(bigger: Array<T>, smaller: Array<T>, key: keyof T) {
    const smallerSet = new Set(smaller.map(item => item[key]));
    return bigger.filter(item => !smallerSet.has(item[key]));
}

import type { ImportSourceType } from '@ever-works/contracts/api';

export const LINKED_DIRECTORY_SYNC_UNSUPPORTED_MESSAGE =
    'Linked directories use existing repositories directly and cannot be synced from an import source.';

const SYNCABLE_SOURCE_TYPES = new Set<ImportSourceType>([
    'data_repo',
    'awesome_readme',
    'works_config',
]);

export function supportsDirectorySourceSync(sourceType?: ImportSourceType | null): boolean {
    return !!sourceType && SYNCABLE_SOURCE_TYPES.has(sourceType);
}

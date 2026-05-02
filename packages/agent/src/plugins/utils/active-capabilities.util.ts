import type { DirectoryPluginEntity } from '../entities/directory-plugin.entity';

type ActiveCapabilitiesRecord = Pick<DirectoryPluginEntity, 'activeCapabilities'>;

export function getActiveCapabilities(directoryPlugin?: ActiveCapabilitiesRecord | null): string[] {
    return Array.from(new Set((directoryPlugin?.activeCapabilities ?? []).filter(Boolean)));
}

export function hasActiveCapability(
    directoryPlugin: ActiveCapabilitiesRecord | null,
    capability: string,
): boolean {
    return getActiveCapabilities(directoryPlugin).includes(capability);
}

export function addActiveCapability(
    directoryPlugin: ActiveCapabilitiesRecord,
    capability: string,
): string[] {
    return Array.from(new Set([...getActiveCapabilities(directoryPlugin), capability]));
}

export function removeActiveCapability(
    directoryPlugin: ActiveCapabilitiesRecord,
    capability: string,
): string[] {
    return getActiveCapabilities(directoryPlugin).filter((active) => active !== capability);
}

import type { WorkPluginEntity } from '../entities/work-plugin.entity';

type ActiveCapabilitiesRecord = Pick<WorkPluginEntity, 'activeCapabilities'>;

export function getActiveCapabilities(workPlugin?: ActiveCapabilitiesRecord | null): string[] {
    return Array.from(new Set((workPlugin?.activeCapabilities ?? []).filter(Boolean)));
}

export function hasActiveCapability(
    workPlugin: ActiveCapabilitiesRecord | null,
    capability: string,
): boolean {
    return getActiveCapabilities(workPlugin).includes(capability);
}

export function addActiveCapability(
    workPlugin: ActiveCapabilitiesRecord,
    capability: string,
): string[] {
    return Array.from(new Set([...getActiveCapabilities(workPlugin), capability]));
}

export function removeActiveCapability(
    workPlugin: ActiveCapabilitiesRecord,
    capability: string,
): string[] {
    return getActiveCapabilities(workPlugin).filter((active) => active !== capability);
}

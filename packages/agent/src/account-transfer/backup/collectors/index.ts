import { BACKUP_DOMAINS, type BackupDomainKey } from '@ever-works/contracts';
import type { BackupCollector } from './collector.types';
import { BACKUP_DOMAIN_SPECS } from './domain-specs';
import { EntityBackupCollector } from './entity-collector';

export * from './collector.types';
export * from './domain-specs';
export * from './entity-collector';

/**
 * Workspace backup (AW-22) — the collector registry.
 *
 * Built from {@link BACKUP_DOMAIN_SPECS} rather than hand-maintained, so a
 * domain can never appear in the format with nothing behind it. The runner
 * walks `BACKUP_DOMAINS` (the published order) and looks each key up here; a
 * key with no collector is reported as `failed` with `collector_missing`
 * rather than quietly skipped, and a unit spec fails the build long before
 * that can reach anyone's archive.
 */
export const BACKUP_COLLECTORS: ReadonlyMap<BackupDomainKey, BackupCollector> = new Map(
    BACKUP_DOMAIN_SPECS.map((spec) => [
        spec.key,
        new EntityBackupCollector(spec) as BackupCollector,
    ]),
);

/** The collector for one domain, or `undefined` when the registry has none. */
export function getBackupCollector(key: BackupDomainKey): BackupCollector | undefined {
    return BACKUP_COLLECTORS.get(key);
}

/** Domain keys the format publishes that the registry cannot produce. Empty, and asserted so. */
export function missingCollectorKeys(): BackupDomainKey[] {
    return BACKUP_DOMAINS.filter((domain) => !BACKUP_COLLECTORS.has(domain.key)).map(
        (domain) => domain.key,
    );
}

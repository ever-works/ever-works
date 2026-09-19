import * as accountTransferBarrel from './index';
import { AccountTransferModule } from './account-transfer.module';
import { AccountExportService } from './account-export.service';
import { AccountImportService } from './account-import.service';
import { GitHubSyncService } from './github-sync.service';
import { UserSyncConfig } from './entities/user-sync-config.entity';
import { UserSyncConfigRepository } from './repositories/user-sync-config.repository';
import { AccountExportWorkContentSource, BACKUP_WORK_CONTENT } from './backup/backup-work-content';

/**
 * Pins the public `@ever-works/agent/account-transfer` barrel surface and
 * the `AccountTransferModule` provider/exports map. Both are wire-format-
 * stable contracts: `apps/api/src/account/` imports the same names; flipping
 * a `provide`/`useClass` mapping or dropping a re-export here is a breaking
 * change for the API layer that calls these services.
 *
 * Note the deliberate decoupling between the three internal-helper
 * repositories (`PluginRepository`/`UserPluginRepository`/`WorkPluginRepository`)
 * which the module re-provides locally for `AccountImportService` AND the
 * single `UserSyncConfigRepository` which is exported because GitHub-sync
 * status queries call it directly from the controller layer.
 */
describe('AccountTransferModule + barrel re-exports', () => {
    describe('barrel re-exports', () => {
        it('re-exports AccountTransferModule', () => {
            expect(accountTransferBarrel.AccountTransferModule).toBe(AccountTransferModule);
        });

        it('re-exports the three services', () => {
            expect(accountTransferBarrel.AccountExportService).toBe(AccountExportService);
            expect(accountTransferBarrel.AccountImportService).toBe(AccountImportService);
            expect(accountTransferBarrel.GitHubSyncService).toBe(GitHubSyncService);
        });

        it('re-exports the entity and the repository', () => {
            expect(accountTransferBarrel.UserSyncConfig).toBe(UserSyncConfig);
            expect(accountTransferBarrel.UserSyncConfigRepository).toBe(UserSyncConfigRepository);
        });

        it('re-exports the type-helper runtime symbols (mask helpers + prefix constant)', () => {
            // The `types.ts` file mixes runtime helpers and pure type aliases;
            // type-only exports erase to nothing at runtime, so we pin only
            // the runtime ones here. Adding a new helper to `types.ts` should
            // also surface here so consumers don't get tree-shaken into
            // breakage.
            expect(typeof accountTransferBarrel.maskSecretValue).toBe('function');
            expect(typeof accountTransferBarrel.maskSecretSettings).toBe('function');
            expect(typeof accountTransferBarrel.containsMaskedSecrets).toBe('function');
            expect(accountTransferBarrel.MASKED_SECRET_PREFIX).toBe('MASKED:');
        });

        it('exposes exactly the documented runtime symbols (no silent additions)', () => {
            // Compare a sorted list — TypeScript erases type-only re-exports,
            // so the runtime keys MUST match this exact set.
            const runtimeKeys = Object.keys(accountTransferBarrel).sort();
            expect(runtimeKeys).toEqual(
                [
                    'AccountTransferModule',
                    'AccountExportService',
                    'AccountImportService',
                    // PR #1019 — Agents/Skills/Tasks v2 payload tail
                    // export+import services.
                    'AgentsSkillsTasksExportService',
                    'AgentsSkillsTasksImportService',
                    'GitHubSyncService',
                    'UserSyncConfig',
                    'UserSyncConfigRepository',
                    'MASKED_SECRET_PREFIX',
                    'maskSecretValue',
                    'maskSecretSettings',
                    'containsMaskedSecrets',
                    // AW-22 Workspace backup — the complete, dated archive
                    // that sits BESIDE the export/import/sync path above.
                    // Everything before this comment is unchanged.
                    'WorkspaceBackupService',
                    'WorkspaceBackupRunner',
                    'BackupArchiveWriter',
                    'BackupArchiveAbortedError',
                    'BackupArchiveTooLargeError',
                    'BACKUP_CHECKSUMS_ENTRY',
                    'stableStringify',
                    'buildManifest',
                    'summarizeManifest',
                    'countCompleteDomains',
                    'hasGaps',
                    'buildReadme',
                    'countReadmeWords',
                    'TypeOrmBackupRowSource',
                    'BACKUP_STORAGE',
                    'BACKUP_ARCHIVE_MIME_TYPE',
                    'PluginBackupStorage',
                    'BACKUP_ACTIVITY_RECORDER',
                    'BACKUP_NOTIFIER',
                    // The Work content port. One implementation, delegating
                    // to the account export's own data-repo walk, so the
                    // archive and the JSON export read a Work's items the
                    // same single way (Constitution III).
                    'BACKUP_WORK_CONTENT',
                    'EMPTY_BACKUP_WORK_CONTENT',
                    'AccountExportWorkContentSource',
                    // Redaction — the one place that decides what never
                    // reaches an archive (spec FR-18).
                    'BACKUP_EXCLUSIONS',
                    'BACKUP_DROPPED_ENTITIES',
                    'BACKUP_BENIGN_COLUMNS',
                    // EW-818. The per-ENTITY exemption map and its predicate,
                    // for free-form bag columns whose NAME is too ordinary to
                    // exempt globally — `metadata` is declared on ten exported
                    // entities, and one entry in the name-keyed map above
                    // would wave all ten through at once.
                    'BACKUP_BENIGN_ENTITY_COLUMNS',
                    'shouldDropEntirely',
                    'isRedactedColumn',
                    'isDroppedColumn',
                    'isBenignColumn',
                    'isBenignEntityColumn',
                    'redactSecretBag',
                    'redactRow',
                    // Collectors — the fifteen domains and the one engine
                    // that reads them.
                    'BACKUP_COLLECTORS',
                    'BACKUP_DOMAIN_SPECS',
                    'EntityBackupCollector',
                    'getBackupCollector',
                    'missingCollectorKeys',
                    'referencedEntities',
                    'withRetries',
                ].sort(),
            );
        });
    });

    describe('AccountTransferModule decorator metadata', () => {
        function getMeta(key: 'imports' | 'providers' | 'exports'): any[] {
            return Reflect.getMetadata(key, AccountTransferModule) ?? [];
        }

        it('declares the three services as providers', () => {
            const providers = getMeta('providers');
            expect(providers).toContain(AccountExportService);
            expect(providers).toContain(AccountImportService);
            expect(providers).toContain(GitHubSyncService);
        });

        it('declares UserSyncConfigRepository as a provider', () => {
            const providers = getMeta('providers');
            expect(providers).toContain(UserSyncConfigRepository);
        });

        it('exports the four user-facing symbols (services + UserSyncConfigRepository)', () => {
            const exports = getMeta('exports');
            expect(exports).toContain(AccountExportService);
            expect(exports).toContain(AccountImportService);
            expect(exports).toContain(GitHubSyncService);
            expect(exports).toContain(UserSyncConfigRepository);
        });

        it('does NOT export the three plugin-related repositories that are re-provided locally for the importer', () => {
            // PluginRepository / UserPluginRepository / WorkPluginRepository
            // are imported by AccountImportService but consumers should keep
            // talking to the canonical PluginsModule for those — pinning the
            // module-export surface prevents accidental duplication.
            const exports = getMeta('exports');
            const exportedNames = exports.map((p: any) => p?.name ?? String(p));
            expect(exportedNames).not.toContain('PluginRepository');
            expect(exportedNames).not.toContain('UserPluginRepository');
            expect(exportedNames).not.toContain('WorkPluginRepository');
        });

        it('binds the AW-22 Work content port to the account export service walk', () => {
            // The archive must carry each Work's items, categories, tags,
            // collections and comparisons — content that lives in the Work's
            // own data repo, not in our database. There must be exactly ONE
            // reader of that repo, and it is the account export's. This pins
            // that the port resolves to a delegation to that service rather
            // than to a second walk (Constitution III).
            const providers = getMeta('providers');
            expect(providers).toContain(AccountExportWorkContentSource);

            const bound = providers.find(
                (p: any) => p && typeof p === 'object' && p.provide === BACKUP_WORK_CONTENT,
            );
            expect(bound).toBeDefined();
            expect(bound.useExisting).toBe(AccountExportWorkContentSource);
        });

        it('imports DatabaseModule (where the canonical work/user/auth repos live)', () => {
            const imports = getMeta('imports');
            const importNames = imports.map((m: any) => m?.name ?? String(m));
            expect(importNames).toContain('DatabaseModule');
        });

        it('imports FacadesModule (for GitFacadeService)', () => {
            const imports = getMeta('imports');
            const importNames = imports.map((m: any) => m?.name ?? String(m));
            expect(importNames).toContain('FacadesModule');
        });

        it('declares a TypeORM forFeature dynamic module among its imports', () => {
            // The `forFeature([UserSyncConfig, PluginEntity, UserPluginEntity,
            // WorkPluginEntity])` call returns a DynamicModule. Its internal
            // shape (entity-token providers) varies by TypeORM/Nest version
            // and is not part of this module's stable contract — we only
            // pin that the import is present. Entity-token resolution is
            // already covered by NestJS itself; the four entity types are
            // pinned at the source-code level via the `forFeature([...])`
            // array literal.
            const imports = getMeta('imports');
            const dynamicTypeOrm = imports.find(
                (m: any) =>
                    m && typeof m === 'object' && m.module && m.module.name === 'TypeOrmModule',
            );
            expect(dynamicTypeOrm).toBeDefined();
            // Cross-check: the entity classes are referenced by the source
            // file directly so they cannot be silently dropped. (Inspect
            // the TypeORM dynamic module by smoke-checking it has the
            // expected NestJS-DynamicModule shape.)
            expect(dynamicTypeOrm.module).toBeDefined();
            expect(Array.isArray(dynamicTypeOrm.providers)).toBe(true);
        });
    });
});

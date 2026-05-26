import * as facadesBarrel from '../index';
import { FacadesModule } from '../facades.module';
import { AiFacadeService } from '../ai.facade';
import { SearchFacadeService } from '../search.facade';
import { ScreenshotFacadeService } from '../screenshot.facade';
import { ContentExtractorFacadeService } from '../content-extractor.facade';
import { DataSourceFacadeService } from '../data-source.facade';
import { GitFacadeService } from '../git.facade';
import { OAuthFacadeService } from '../oauth.facade';
import { DeployFacadeService } from '../deploy.facade';
import { CodeEditFacadeService } from '../code-edit.facade';
import { PromptFacadeService } from '../prompt.facade';
// PR #1019 (Skills + Tasks) — two new facades.
import { SkillsFacadeService } from '../skills.facade';
import { TasksFacadeService } from '../tasks.facade';

/**
 * Pins the `FacadesModule` provider/exports map AND the public
 * `@ever-works/agent/facades` barrel surface. Both are wire-format-stable:
 * `apps/api/src/plugins-capabilities/*` and the agent pipeline steps import
 * the same facade classes by name. A silent removal/rename here would
 * change which provider Nest hands consumers, so each binding is pinned
 * individually rather than only via a "count" assertion.
 */

describe('FacadesModule + barrel re-exports', () => {
    const FACADE_CLASSES = [
        AiFacadeService,
        SearchFacadeService,
        ScreenshotFacadeService,
        ContentExtractorFacadeService,
        DataSourceFacadeService,
        GitFacadeService,
        OAuthFacadeService,
        DeployFacadeService,
        CodeEditFacadeService,
        PromptFacadeService,
        // PR #1019 — Skills + Tasks facades.
        SkillsFacadeService,
        TasksFacadeService,
    ] as const;

    describe('@Module() decorator metadata', () => {
        function getMeta(key: 'imports' | 'providers' | 'exports'): unknown[] {
            return (Reflect.getMetadata(key, FacadesModule) ?? []) as unknown[];
        }

        it('imports DatabaseModule by name (where plugin/work repositories are bound)', () => {
            const imports = getMeta('imports');
            const importNames = imports.map((m) => (m as { name?: string })?.name ?? String(m));
            // Pin by name — coupling to the DatabaseModule constructor identity
            // would create a silent test-side dependency on its export path.
            expect(importNames).toContain('DatabaseModule');
        });

        it('declares all ten facade classes as providers (one entry per facade, no extras)', () => {
            const providers = getMeta('providers');
            for (const cls of FACADE_CLASSES) {
                expect(providers).toContain(cls);
            }
            // The constants array is `providers === exports` (both reference the
            // shared `FACADES` const). Pin both length and identity so a future
            // "add an internal-only provider via spread" silently adds it to
            // exports too — that should be a deliberate edit.
            expect(providers).toHaveLength(FACADE_CLASSES.length);
        });

        it('exports all ten facade classes (one-to-one with providers)', () => {
            const exports = getMeta('exports');
            for (const cls of FACADE_CLASSES) {
                expect(exports).toContain(cls);
            }
            expect(exports).toHaveLength(FACADE_CLASSES.length);
        });

        it('shares one providers/exports array (so a single edit covers both)', () => {
            // Pinned: the module body is `providers: FACADES, exports: FACADES`.
            // A future split into `providers` + a smaller `exports` would
            // silently make some facades private — that is a deliberate change
            // and should require updating this test.
            const providers = getMeta('providers');
            const exports = getMeta('exports');
            expect(providers).toEqual(exports);
        });
    });

    describe('barrel re-exports', () => {
        it('re-exports FacadesModule', () => {
            expect(facadesBarrel.FacadesModule).toBe(FacadesModule);
        });

        it('re-exports each of the ten facade service classes verbatim', () => {
            expect(facadesBarrel.AiFacadeService).toBe(AiFacadeService);
            expect(facadesBarrel.SearchFacadeService).toBe(SearchFacadeService);
            expect(facadesBarrel.ScreenshotFacadeService).toBe(ScreenshotFacadeService);
            expect(facadesBarrel.ContentExtractorFacadeService).toBe(ContentExtractorFacadeService);
            expect(facadesBarrel.DataSourceFacadeService).toBe(DataSourceFacadeService);
            expect(facadesBarrel.GitFacadeService).toBe(GitFacadeService);
            expect(facadesBarrel.OAuthFacadeService).toBe(OAuthFacadeService);
            expect(facadesBarrel.DeployFacadeService).toBe(DeployFacadeService);
            expect(facadesBarrel.CodeEditFacadeService).toBe(CodeEditFacadeService);
            expect(facadesBarrel.PromptFacadeService).toBe(PromptFacadeService);
        });

        it('re-exports each facade-specific error class (one per capability that defines errors)', () => {
            // ai
            expect(typeof facadesBarrel.AiFacadeError).toBe('function');
            // search
            expect(typeof facadesBarrel.SearchFacadeError).toBe('function');
            // screenshot
            expect(typeof facadesBarrel.ScreenshotFacadeError).toBe('function');
            // content-extractor
            expect(typeof facadesBarrel.ContentExtractorFacadeError).toBe('function');
            expect(typeof facadesBarrel.NoContentExtractorProviderError).toBe('function');
            expect(typeof facadesBarrel.ContentExtractorProviderNotFoundError).toBe('function');
            // data-source
            expect(typeof facadesBarrel.DataSourceFacadeError).toBe('function');
            // git
            expect(typeof facadesBarrel.GitFacadeError).toBe('function');
            expect(typeof facadesBarrel.NoGitProviderError).toBe('function');
            expect(typeof facadesBarrel.GitProviderNotFoundError).toBe('function');
            expect(typeof facadesBarrel.NoGitCredentialsError).toBe('function');
            // oauth
            expect(typeof facadesBarrel.OAuthFacadeError).toBe('function');
            expect(typeof facadesBarrel.NoOAuthProviderError).toBe('function');
            expect(typeof facadesBarrel.OAuthProviderNotFoundError).toBe('function');
            expect(typeof facadesBarrel.OAuthNotSupportedError).toBe('function');
            // deploy
            expect(typeof facadesBarrel.DeployFacadeError).toBe('function');
            expect(typeof facadesBarrel.NoDeployProviderError).toBe('function');
            expect(typeof facadesBarrel.DeployProviderNotFoundError).toBe('function');
            expect(typeof facadesBarrel.NoDeployCredentialsError).toBe('function');
        });

        it('re-exports the shared FacadeError + base classes (NoProviderError / ProviderNotFoundError)', () => {
            expect(typeof facadesBarrel.BaseFacadeService).toBe('function');
            expect(typeof facadesBarrel.FacadeError).toBe('function');
            expect(typeof facadesBarrel.NoProviderError).toBe('function');
            expect(typeof facadesBarrel.ProviderNotFoundError).toBe('function');
        });

        it('exposes the documented runtime-symbol set (regression guard against silent additions)', () => {
            const runtimeKeys = Object.keys(facadesBarrel).sort();
            // Type-only re-exports are erased by `tsc` so they MUST NOT appear here:
            // DefaultProviderInfo, FacadeOptions, SearchFacadeOptions,
            // FacadeExtractionOptions, FacadeExtractedContent, GitFacadeOptions,
            // GitProviderInfo, FacadeCloneOptions, FacadePushOptions,
            // DataSourceFacadeOptions, DataSourceFacadeResult, EnabledDataSource,
            // DeployFacadeFullOptions.
            expect(runtimeKeys).toEqual(
                [
                    'AiFacadeError',
                    'AiFacadeService',
                    'BaseFacadeService',
                    'CodeEditFacadeService',
                    'ContentExtractorFacadeError',
                    'ContentExtractorFacadeService',
                    'ContentExtractorProviderNotFoundError',
                    'DataSourceFacadeError',
                    'DataSourceFacadeService',
                    'DeployFacadeError',
                    'DeployFacadeService',
                    'DeployProviderNotFoundError',
                    'FacadeError',
                    'FacadesModule',
                    'GitFacadeError',
                    'GitFacadeService',
                    'GitProviderNotFoundError',
                    'NoContentExtractorProviderError',
                    'NoDeployCredentialsError',
                    'NoDeployProviderError',
                    'NoGitCredentialsError',
                    'NoGitProviderError',
                    'NoOAuthProviderError',
                    'NoProviderError',
                    'OAuthFacadeError',
                    'OAuthFacadeService',
                    'OAuthNotSupportedError',
                    'OAuthProviderNotFoundError',
                    'PLATFORM_MANAGED_KUBECONFIG_SENTINEL',
                    'PromptFacadeService',
                    'ProviderNotFoundError',
                    'ScreenshotFacadeError',
                    'ScreenshotFacadeService',
                    'SearchFacadeError',
                    'SearchFacadeService',
                    // PR #1019 — Skills + Tasks facades.
                    'SkillsFacadeError',
                    'SkillsFacadeService',
                    'TasksFacadeError',
                    'TasksFacadeService',
                ].sort(),
            );
        });
    });
});

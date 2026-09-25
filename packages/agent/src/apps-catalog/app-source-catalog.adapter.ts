/**
 * APW-03 — `AppSourceCatalogAdapter`, the binding of APW-01's
 * `APP_SOURCE_CATALOG_PORT` (APW-03 plan §2.7; the port is
 * `app-works/app-source-catalog.port.ts`).
 *
 * `AppWorksModule` binds it, beside the inspector and the create service that
 * inject the port (a binding anywhere else would not reach them — see that
 * module's docstring). What it answers:
 *
 *  - `matchBlueprint` — through {@link AppBlueprintResolverService}, which today
 *    implements the **explicit** (FR-81) and **probe** (FR-43) paths only; the
 *    manifest, alias and fork-network paths are still open (T24/T26), so a
 *    repository only a manifest names answers `null` ("no match") for now.
 *  - `classifyLicense` — the pure registry classifier on the bundled seed
 *    snapshot; it never throws and never guesses (`null` ⇒ `unknown`,
 *    `NOASSERTION` ⇒ `red`).
 *
 * ## 🛑 The apply gate — no Blueprint is offered while nothing can apply it
 *
 * A match is not a preview decoration: the create path persists `blueprintId`
 * from it, and APW-01's ready handler then REQUESTS an apply for every Work that
 * has one, answering `failed/blueprint_unavailable` when
 * `APP_BLUEPRINT_APPLY_SERVICE` is unbound — which it is on this branch (APW-03
 * T28 is open; APW-03 tasks.md T55 planned the catalog and apply seams to merge
 * together, before APW-01 P1). Offering a match now would therefore turn today's
 * working outcome (no match ⇒ no `blueprintId` ⇒ a minimal-path App Work) into a
 * readiness FAILURE for every matched repository and every explicit id.
 *
 * So a **hit** is answered only when the apply service is bound; otherwise
 * `matchBlueprint` rejects with {@link AppBlueprintApplyUnavailableError}, which
 * every consumer already reads as "unavailable" (the inspector previews
 * `unavailable`/`unknown`, the create path refuses an explicit id with
 * `400 blueprint_mismatch` before writing anything — exactly today's answers). A
 * **miss** is honest either way and is answered as `null`, so the preview says
 * `none` and the detected licence is classified.
 *
 * **T28's obligation:** bind `APP_BLUEPRINT_APPLY_SERVICE` so that it resolves
 * from `packages/agent/src/app-works/app-works.module.ts`'s graph (provided there,
 * or exported by a module it imports) — not only from
 * `apps/api/src/app-works/app-works.module.ts`. If it is bound only API-side, this
 * gate stays closed: safe, but no Blueprint is ever offered.
 *
 * ## Errors, as the port's consumers need them
 *
 * - {@link AppsCatalogCredentialUnavailableError} is re-thrown: "the platform could
 *   not look" must read as `unavailable`, never as "no match".
 * - Any other resolver throw is `null` (T26: "a throwing resolver mapped to null");
 *   the resolver already maps provider failures to `none/lookupFailed` itself.
 * - No resolver in the graph ⇒ reject (unavailable).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { classifyLicenseExpression } from '../app-license/license-classify';
import type { AppSourceCatalogPort } from '../app-works/app-source-catalog.port';
import {
    APP_BLUEPRINT_APPLY_SERVICE,
    type AppBlueprintApplyCapability,
} from '../app-works/app-source-initializer.service';
import {
    AppBlueprintResolverService,
    AppsCatalogCredentialUnavailableError,
} from './app-blueprint-resolver.service';

type AppSourceCatalogMatch = Awaited<ReturnType<AppSourceCatalogPort['matchBlueprint']>>;
type AppSourceLicenseClass = Awaited<ReturnType<AppSourceCatalogPort['classifyLicense']>>;

/** A Blueprint matched, and nothing in this graph can apply it (APW-03 T28 open). */
export class AppBlueprintApplyUnavailableError extends Error {
    constructor(blueprintId: string) {
        super(
            `The Blueprint "${blueprintId}" matched, but no Blueprint apply service is bound ` +
                '(APP_BLUEPRINT_APPLY_SERVICE, APW-03 T28), so it is not offered.',
        );
        this.name = 'AppBlueprintApplyUnavailableError';
    }
}

@Injectable()
export class AppSourceCatalogAdapter implements AppSourceCatalogPort {
    private readonly logger = new Logger(AppSourceCatalogAdapter.name);

    constructor(
        @Optional()
        private readonly resolver?: AppBlueprintResolverService,
        @Optional()
        @Inject(APP_BLUEPRINT_APPLY_SERVICE)
        private readonly blueprintApply?: AppBlueprintApplyCapability,
    ) {}

    async matchBlueprint(input: {
        owner: string;
        repo: string;
        blueprintId?: string;
    }): Promise<AppSourceCatalogMatch> {
        if (!this.resolver) {
            throw new Error('The Apps catalog Blueprint resolver is not provided in this graph.');
        }

        let resolution: Awaited<ReturnType<AppBlueprintResolverService['resolve']>>;
        try {
            resolution = await this.resolver.resolve(input);
        } catch (error) {
            if (error instanceof AppsCatalogCredentialUnavailableError) {
                throw error;
            }
            this.logger.warn(
                `Blueprint resolution threw for ${input.owner}/${input.repo} ` +
                    `(${error instanceof Error ? error.message : String(error)}); answering no match.`,
            );
            return null;
        }

        if (resolution.status !== 'hit') {
            return null;
        }

        // The gate — see the docstring.
        if (!this.blueprintApply) {
            throw new AppBlueprintApplyUnavailableError(resolution.id);
        }

        const prompts = (resolution.prompts ?? []).map((prompt) => ({
            name: prompt.name,
            ...(prompt.description !== undefined ? { description: prompt.description } : {}),
            required: prompt.required,
        }));

        return {
            id: resolution.id,
            version: resolution.version,
            // Explicit and probe matches are never verified (FR-43, FR-81).
            verified: false,
            name: resolution.name,
            ...(resolution.displayName ? { displayName: resolution.displayName } : {}),
            matchSource: resolution.source,
            ...(resolution.spdx !== undefined ? { spdx: resolution.spdx } : {}),
            // Computed from the declared SPDX; a class the Blueprint declares is ignored (R-3).
            licenseClass: classifyLicenseExpression(resolution.spdx),
            ...(prompts.length > 0 ? { prompts } : {}),
        };
    }

    async classifyLicense(spdx: string | null): Promise<AppSourceLicenseClass> {
        try {
            return classifyLicenseExpression(spdx);
        } catch {
            return 'unknown';
        }
    }
}

import { Controller, Get, Header, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    APPS_CATALOG_PUBLIC_PER_MIN,
    type AppsLicenseRegistryItem,
    type AppsLicenseRegistryResponse,
} from '@ever-works/contracts';
import {
    LICENSE_REGISTRY_SNAPSHOT,
    LICENSE_REGISTRY_SNAPSHOT_SOURCE,
    type LicenseRegistryContent,
} from '@ever-works/agent/app-license';
import { config } from '@ever-works/agent/config';
import { Public } from '../auth';

/**
 * APW-03 T25 (lane aw-blueprints) — `GET /api/apps-catalog/licenses`, the licence
 * registry read (plan §4.1:549):
 *
 * ```
 * { items: [{ spdx, name, class, obligations, attestationTextId? }], registrySource, … }
 * ```
 *
 * What a licence is classified as, which obligations it carries, and which attestation
 * text an owner confirms for it — the facts behind the App spec tab's licence card and
 * the catalog's `licenseNotGreen` / `upstreamAgreementMissing` reasons, readable before
 * signing in.
 *
 * **The registry in force is the bundled snapshot** (`registrySource: 'snapshot'`): the
 * live / last-good read of `ever-works/templates`' `licenses.yml` is T40, held for legal
 * review (EXT-19), and `legalReviewed: false` says so. The attestation TEXT is not
 * served here — only its id; the text is what the attest dialog shows the owner.
 *
 * `@Public()`, `Cache-Control: public, max-age=300`, 120 per minute per client (plan
 * §4.1), and refused `400 app_works_disabled` while App Works is off, like every catalog
 * route, so a hidden surface is not reachable by URL. Registered BEFORE
 * `AppsCatalogController` in `WorksModule`, so `licenses` is never read as an `:id`.
 */
@ApiTags('Works')
@Controller('api/apps-catalog')
export class AppsCatalogLicensesController {
    @Get('licenses')
    @Public()
    @Header('Cache-Control', 'public, max-age=300')
    @Throttle({ long: { limit: APPS_CATALOG_PUBLIC_PER_MIN, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Read the App licence registry',
        description:
            'Every licence the registry classifies (green, amber or red), its obligations and the id of the ' +
            'attestation text an owner confirms for amber and red. `registrySource` is `snapshot` until the live ' +
            'registry read lands; `legalReviewed` is `false` until the registry is reviewed. No authentication.',
    })
    @ApiResponse({ status: 200, description: '`AppsLicenseRegistryResponse`.' })
    @ApiResponse({ status: 400, description: '`app_works_disabled`.' })
    licenses(): AppsLicenseRegistryResponse {
        if (!config.everWorks.apps.worksEnabled()) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'app_works_disabled',
                    message: 'App Works are not available on this instance.',
                },
                HttpStatus.BAD_REQUEST,
            );
        }
        return licenseRegistryListing(LICENSE_REGISTRY_SNAPSHOT, {
            registrySource: 'snapshot',
            legalReviewed: LICENSE_REGISTRY_SNAPSHOT_SOURCE.legalReviewed,
        });
    }
}

/**
 * The public projection of a registry: rows sorted by class then SPDX id, obligations
 * copied, the attestation text reduced to its id. Pure.
 */
export function licenseRegistryListing(
    registry: LicenseRegistryContent,
    meta: Pick<AppsLicenseRegistryResponse, 'registrySource' | 'legalReviewed'>,
): AppsLicenseRegistryResponse {
    const order = { green: 0, amber: 1, red: 2 } as const;
    const items: AppsLicenseRegistryItem[] = registry.licenses
        .map((row) => ({
            spdx: row.spdx,
            name: row.name,
            class: row.class,
            obligations: [...row.obligations],
            ...(row.attestation?.textId ? { attestationTextId: row.attestation.textId } : {}),
        }))
        .sort((a, b) => order[a.class] - order[b.class] || a.spdx.localeCompare(b.spdx));
    const rules = (key: 'green' | 'amber' | 'red') => ({
        managedHosting: registry.classes[key].managedHosting,
        yourCluster: registry.classes[key].yourCluster,
        attestation: registry.classes[key].attestation,
    });
    return {
        items,
        registrySource: meta.registrySource,
        updatedAt: registry.updatedAt,
        legalReviewed: meta.legalReviewed,
        classes: { green: rules('green'), amber: rules('amber'), red: rules('red') },
        unknownClass: registry.unknown?.class ?? 'red',
    };
}

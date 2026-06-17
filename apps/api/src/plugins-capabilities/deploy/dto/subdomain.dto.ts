import { IsString, IsNotEmpty, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * EW-739 — managed-subdomain read/write DTOs.
 *
 * `GET /api/deploy/works/:id/subdomain` returns a `SubdomainResponseDto`:
 *   - `subdomain` — the leftmost label persisted on `work.managedSubdomain`
 *     (e.g. `my-site`), or `null` if no managed subdomain is allocated yet.
 *   - `fqdn` — fully qualified host (`${subdomain}.${rootDomain}`), or `null`.
 *   - `url` — `https://${fqdn}`, or `null`.
 *   - `recordOk` — `true` iff `provider.recordExists(fqdn)` resolved truthy,
 *     i.e. the DNS record exists in the managed zone (caller-visible health
 *     signal). Always `false` when `subdomain` is `null`.
 *   - `editable` — `true` when the caller can re-allocate; gated on
 *     `work.deployProvider ∈ {'ever-works','k8s'}` (the only providers that
 *     run through `applyManagedSubdomain`) AND, for k8s, on the
 *     `EW734_K8S_MANAGED_SUBDOMAIN` env flag being active so the operator
 *     opt-in is respected.
 *
 * `PUT /api/deploy/works/:id/subdomain` validates `UpdateSubdomainDto` per
 * spec §7: strict `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` regex (no leading/trailing
 * dashes), 1–63 chars (RFC 1035 label length cap). The platform also rejects
 * the blocklist (`www`, `api`, `app`, `admin`, `mail`, …) at the service
 * layer — that's not expressible cleanly via class-validator decorators
 * since it's a runtime allowlist, and surfacing the rejection from the
 * service lets us share the same set with `SubdomainAllocator`.
 */
export class SubdomainResponseDto {
    @ApiProperty({
        description: 'Leftmost label persisted on work.managedSubdomain',
        nullable: true,
        example: 'my-site',
    })
    subdomain!: string | null;

    @ApiProperty({
        description: 'Fully qualified host (${subdomain}.${rootDomain})',
        nullable: true,
        example: 'my-site.ever.works',
    })
    fqdn!: string | null;

    @ApiProperty({
        description: 'https://${fqdn}',
        nullable: true,
        example: 'https://my-site.ever.works',
    })
    url!: string | null;

    @ApiProperty({
        description: 'true iff the DNS record exists in the managed zone',
        example: true,
    })
    recordOk!: boolean;

    @ApiProperty({
        description:
            'true iff the caller can edit (provider ∈ {ever-works,k8s} and managed mode active)',
        example: true,
    })
    editable!: boolean;
}

export class UpdateSubdomainDto {
    @ApiProperty({
        description:
            'New leftmost label for the managed subdomain. Must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ (RFC 1035 host label), 1-63 chars.',
        example: 'my-site',
    })
    @IsString()
    @IsNotEmpty()
    @Length(1, 63, { message: 'Subdomain must be 1-63 characters long' })
    @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
        message:
            'Invalid subdomain format. Must be lowercase letters, digits, and dashes (no leading/trailing dash). Example: my-site',
    })
    subdomain!: string;
}

import {
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { LicenseAttestation, LicenseClass } from '@ever-works/contracts';
import { AppSpecService } from '@ever-works/agent/app-spec';
// The ONE rule for the text and for "is the stored attestation still valid" — the
// same functions the attest route and the deploy gate use (APW-03 T44).
import { attestationIsValid, attestationTextFor } from '@ever-works/agent/app-license';
import { WorkOwnershipService, type WorkAccessResult } from '@ever-works/agent/services';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * `GET /api/works/:id/app-license` — what the attestation dialog needs to show
 * BEFORE the owner attests (APW-03 T44 / APW-06 T37, R-3).
 *
 * The attest route (`POST /api/works/:id/app-license/attest`, lane aw-catalog)
 * takes the classification the owner reviewed (`{ spdx, class }`) and records
 * the registry text's `textId` / `textSha256` and the licence commit itself. No
 * read route gave the web that text, the classification, or whether an
 * attestation is still needed, so a dialog could not show what is being
 * attested. This is that read — and nothing more: it writes nothing, it never
 * decides eligibility (APW-03's `getHostingEligibility` does), and the attest
 * route re-checks everything it relies on.
 */
export interface WorkAppLicenseView {
    workId: string;
    /** `null` until the licence has been evaluated. */
    spdx: string | null;
    class: LicenseClass | null;
    source: string | null;
    mixed: boolean;
    scanIncomplete: boolean;
    obligations: readonly string[];
    /** The licence commit the attestation will be recorded against. */
    commitSha: string | null;
    evaluatedAt: string | null;
    /** amber, red or unknown (or not yet classified) with no valid attestation for the current text. */
    attestationRequired: boolean;
    attestation: LicenseAttestation | null;
    /** The registry text the owner confirms; `null` for a green licence. */
    attestationText: { textId: string; text: string } | null;
    /** Only the App Work's owner can attest (`403 ownerOnly` otherwise). */
    isOwner: boolean;
}

/** Whether a stored attestation still covers this classification and text (FR-59/FR-60). */
export function attestationCovers(
    attestation: LicenseAttestation | null | undefined,
    spdx: string | null,
    licenseClass: LicenseClass,
    textId: string | null,
): boolean {
    if (!attestation) return false;
    return (
        (attestation.spdx ?? '') === (spdx ?? '') &&
        attestation.class === licenseClass &&
        (textId === null || attestation.textId === textId)
    );
}

@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class WorkAppLicenseController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly appSpec: AppSpecService,
    ) {}

    @Get(':id/app-license')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: "Read an App Work's licence classification and the attestation text",
        description:
            'The classification (SPDX, class, evidence flags, obligations, commit), whether the owner still ' +
            'has to attest it, the stored attestation and the registry text the owner confirms. Writes ' +
            'nothing. 404 for a Work the caller cannot see; 422 notAnAppWork for another kind.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: '`WorkAppLicenseView`.' })
    @ApiResponse({
        status: 404,
        description: '`not_found` — missing, invisible or another account’s.',
    })
    @ApiResponse({ status: 422, description: '`notAnAppWork`.' })
    async read(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<WorkAppLicenseView> {
        const access = await this.authorize(id, auth.userId);
        const read = await this.appSpec.getState(id);
        const state = read.state;

        const spdx = state?.licenseSpdx ?? null;
        const licenseClass = (state?.licenseClass ?? null) as LicenseClass | null;
        // The attest route treats an unclassified licence as `unknown` (it evaluates
        // first), so the read does the same when deciding whether one is needed.
        const effectiveClass: LicenseClass = licenseClass ?? 'unknown';
        const text = effectiveClass === 'green' ? null : attestationTextFor(spdx);
        const attestation = (state?.attestation ?? null) as LicenseAttestation | null;
        const covered = state ? attestationIsValid(state) : false;

        return {
            workId: id,
            spdx,
            class: licenseClass,
            source: state?.licenseSource ?? null,
            mixed: state?.licenseMixed === true,
            scanIncomplete: state?.licenseScanIncomplete === true,
            obligations: state?.licenseObligations ?? [],
            commitSha: state?.licenseCommitSha ?? null,
            evaluatedAt: state?.licenseEvaluatedAt
                ? new Date(state.licenseEvaluatedAt).toISOString()
                : null,
            attestationRequired: effectiveClass !== 'green' && !covered,
            attestation,
            attestationText: text ? { textId: text.textId, text: text.text } : null,
            isOwner: access.work.userId === auth.userId,
        };
    }

    /** One `404` for missing, invisible and another account's Work (ACC-03-41); `422` for another kind. */
    private async authorize(workId: string, userId: string): Promise<WorkAccessResult> {
        let access: WorkAccessResult;
        try {
            access = await this.ownership.ensureCanView(workId, userId);
        } catch (error) {
            if (error instanceof HttpException) {
                const status = error.getStatus();
                if (status === HttpStatus.NOT_FOUND || status === HttpStatus.FORBIDDEN) {
                    throw new HttpException(
                        {
                            status: 'error',
                            code: 'not_found',
                            message: `Work ${workId} not found.`,
                        },
                        HttpStatus.NOT_FOUND,
                    );
                }
            }
            throw error;
        }
        if (access.work.kind !== 'app') {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'notAnAppWork',
                    message: `Work ${workId} is not an App Work, so it has no licence to attest.`,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }
        return access;
    }
}

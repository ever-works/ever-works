import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrganizationInvitationService } from '@ever-works/agent/services';
import { OrganizationRepository } from '@ever-works/agent/database';
import { Public } from '../auth/decorators/public.decorator';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { OrganizationInvitationFlowService } from '../organizations/organization-invitation-flow.service';
import { AcceptOrgInviteDto } from './dto/org-invite.dto';

/** What the signed-out landing page needs to render. 🛑 No token echo. */
export interface OrgInvitePreviewResponse {
    organizationName: string;
    /** Masked — enough to recognise, not enough to harvest. */
    invitedEmailMasked: string;
    expiresAt: string;
}

export interface AcceptOrgInviteResponse {
    organizationId: string;
    organizationSlug: string;
    /** False when this same user had already redeemed it (a double-click). */
    joined: boolean;
}

/**
 * Consumption side of an Organization invitation.
 *
 * Split into a `@Public()` preview and an authenticated accept, mirroring
 * `ClaimController`. That split is what makes a BRAND-NEW person work: they
 * click the link with no account, the preview renders "you have been invited
 * to Acme", they register or sign in, and only then does accept run.
 *
 * Lives in `OnboardingModule` rather than on the org-scoped controller family
 * because those routes all carry `:orgId` and sit behind
 * `OrganizationOwnershipGuard` — which requires membership, the very thing
 * the invitee does not have yet.
 */
@ApiTags('Organizations')
@Controller('api/org-invite')
export class OrgInviteController {
    constructor(
        private readonly invitations: OrganizationInvitationService,
        private readonly organizations: OrganizationRepository,
        private readonly flow: OrganizationInvitationFlowService,
    ) {}

    /**
     * Read an invitation without consuming it.
     *
     * 10/min per IP, matching the claim preview: a token is 256 bits, but a
     * tight throttle is what makes brute-forcing a partially-leaked one
     * infeasible. Somebody landing on the link and reloading twice fits easily.
     *
     * Deliberately does NOT pass a redeemer address to `findConsumable` —
     * there is no signed-in user yet, and this grants nothing.
     */
    @Public()
    // 🛑 POST, not GET, even though this is a read.
    //
    // A GET puts the token in the URL, and this repo persists URLs in two
    // places: `logging.interceptor.ts` logs `Incoming Request: ${method}
    // ${originalUrl}` (forwarded on as $log events), and Sentry attaches
    // `event.request.url` — query string included — to transaction events.
    // Sentry's scrubber only matches pathnames under `/auth`, so this route
    // would not be covered.
    //
    // That would defeat the entire design: the database stores only
    // sha256(token) precisely so the plaintext lives in exactly one place, the
    // email. A request BODY is captured by neither of those two paths.
    @Post('preview')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Preview an organization invitation without consuming it',
        description:
            'Public, and a POST only so the token stays out of URLs and logs. 400 if expired or already accepted, 403 if revoked, 404 if unknown.',
    })
    @ApiResponse({ status: 200, description: 'Invitation preview' })
    async preview(@Body() dto: AcceptOrgInviteDto): Promise<OrgInvitePreviewResponse> {
        const invitation = await this.invitations.findConsumable(dto.token ?? '');
        const organization = await this.organizations.findById(invitation.organizationId);
        if (!organization) {
            throw new BadRequestException('organization_no_longer_exists');
        }

        return {
            organizationName: organization.displayName ?? organization.slug,
            invitedEmailMasked: maskEmail(invitation.email),
            expiresAt: invitation.tokenExpiresAt.toISOString(),
        };
    }

    /**
     * Redeem the invitation as the signed-in user.
     *
     * Every interesting failure is the flow service's:
     *   403 `invitation_email_mismatch` — signed in as somebody else
     *   409 `user_already_in_another_tenant` — already belongs elsewhere
     *   400 `invitation_expired` / `invitation_already_accepted`
     *   403 `invitation_revoked`
     */
    @Post('accept')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthSessionGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({ summary: 'Accept an organization invitation' })
    @ApiResponse({ status: 200, description: 'Joined the Organization' })
    @ApiResponse({ status: 403, description: 'Signed in as a different address' })
    @ApiResponse({ status: 409, description: 'Already a member of another Tenant' })
    async accept(
        @Body() dto: AcceptOrgInviteDto,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<AcceptOrgInviteResponse> {
        return this.flow.accept(dto.token, user.userId);
    }
}

/**
 * `ada@example.com` → `a**@example.com`.
 *
 * The preview is public to anyone holding the token, so returning the full
 * address would turn a leaked link into an address disclosure. Masked is
 * still enough for the real job: telling the recipient WHICH of their
 * accounts to sign in as, since the token is email-bound.
 *
 * (The Work claim preview returns its address in full. This is a deliberate
 * divergence, in the safer direction.)
 */
function maskEmail(email: string): string {
    const at = email.lastIndexOf('@');
    if (at <= 0) return '***';
    const local = email.slice(0, at);
    const domain = email.slice(at);
    if (local.length <= 1) return `*${domain}`;
    return `${local[0]}${'*'.repeat(Math.min(local.length - 1, 3))}${domain}`;
}

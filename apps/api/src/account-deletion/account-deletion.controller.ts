import {
    Body,
    Controller,
    ForbiddenException,
    GoneException,
    Get,
    Header,
    HttpCode,
    HttpException,
    HttpStatus,
    NotFoundException,
    Post,
    Request,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { IntegrationForbiddenGuard } from '../auth/integration/integration-forbidden.guard';
import { SessionCredentialOnly } from '../auth/integration/integration.decorators';
import {
    AccountDeletionTokenService,
    InvalidDeletionLinkError,
} from './account-deletion-token.service';
import { AccountDeletionFailedError, AccountDeletionService } from './account-deletion.service';
import {
    ConfirmAccountDeletionDto,
    DeleteMyAccountDto,
    RequestAccountDeletionDto,
    VerifyAccountDeletionDto,
} from './account-deletion.dto';
import { ACCOUNT_DELETION_LINK_INVALID_MESSAGE, normaliseDeletionEmail } from './account-deletion.tokens';

const linkGone = () => new GoneException({ message: ACCOUNT_DELETION_LINK_INVALID_MESSAGE });

function deletionFailed(error: unknown): never {
    const code = error instanceof AccountDeletionFailedError ? error.code : 'deletion_failed';
    throw new HttpException(
        {
            message:
                code === 'billing_cancel_failed'
                    ? 'We could not cancel your subscription with the payment provider, so nothing was deleted. Please try again in a few minutes.'
                    : 'The account could not be deleted. Please try again or contact support.',
            code,
        },
        HttpStatus.CONFLICT,
    );
}

/**
 * Self-serve account deletion.
 *
 * Public, email-link flow (the shared contract — same shape as Gauzy's):
 * - `POST request`  → always `202 {"status":"accepted"}`; the lookup and the
 *   email run after the answer.
 * - `POST verify`   → what the link would delete; does not use the link.
 * - `POST confirm`  → uses the link (atomic, single use) and deletes.
 *   Every unusable link → one `410`.
 *
 * Signed-in flow: `GET me` (what will be deleted) and `POST me` (typed email
 * confirmation). Session credentials only — never an API key or a run token.
 *
 * No route takes the token in its path or query string: request lines are
 * logged, bodies are not. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('Account deletion')
@Controller('api/account-deletion')
@UseGuards(IntegrationForbiddenGuard)
export class AccountDeletionController {
    constructor(
        private readonly tokens: AccountDeletionTokenService,
        private readonly deletion: AccountDeletionService,
    ) {}

    @Public()
    @Post('request')
    @HttpCode(HttpStatus.ACCEPTED)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Email a link that deletes the account',
        description:
            'Answers 202 for every address — known, unknown or rate limited — and sends the link (valid 30 minutes) only when an account exists. A new request revokes the previous link.',
    })
    @ApiResponse({ status: 202, description: 'Accepted' })
    request(@Body() dto: RequestAccountDeletionDto) {
        return this.tokens.acceptRequest({ email: dto.email, callbackUrl: dto.callbackUrl });
    }

    @Public()
    @Post('verify')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({ summary: 'Show what a deletion link would delete (does not use the link)' })
    @ApiResponse({ status: 200, description: 'What will be deleted' })
    @ApiResponse({ status: 410, description: 'Invalid, used, expired or revoked link' })
    async verify(@Body() dto: VerifyAccountDeletionDto) {
        let request;
        try {
            request = await this.tokens.inspect(dto.token);
        } catch (error) {
            if (error instanceof InvalidDeletionLinkError) throw linkGone();
            throw error;
        }
        if (!request.userId) throw linkGone();
        try {
            const preview = await this.deletion.preview(request.userId);
            return { ...preview, expiresAt: request.expiresAt };
        } catch (error) {
            if (error instanceof NotFoundException) throw linkGone();
            throw error;
        }
    }

    @Public()
    @Post('confirm')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({ summary: 'Use a deletion link and delete the account' })
    @ApiResponse({ status: 200, description: '{ deleted: true, accounts, workspacesDeleted }' })
    @ApiResponse({ status: 410, description: 'Invalid, used, expired or revoked link' })
    async confirm(@Body() dto: ConfirmAccountDeletionDto) {
        let request;
        try {
            request = await this.tokens.claim(dto.token);
        } catch (error) {
            if (error instanceof InvalidDeletionLinkError) throw linkGone();
            throw error;
        }
        if (!request.userId) throw linkGone();
        try {
            const result = await this.deletion.execute(request.userId, {
                source: 'email_link',
                requestId: request.id,
            });
            return {
                deleted: true,
                accounts: result.accounts,
                workspacesDeleted: result.workspacesDeleted,
            };
        } catch (error) {
            if (error instanceof NotFoundException) throw linkGone();
            deletionFailed(error);
        }
    }

    @Get('me')
    @Header('Cache-Control', 'no-store')
    @SessionCredentialOnly('account deletion')
    @ApiBearerAuth()
    @ApiOperation({ summary: 'What deleting the signed-in account would delete' })
    me(@Request() req: { user: { userId: string } }) {
        return this.deletion.preview(req.user.userId);
    }

    @Post('me')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @SessionCredentialOnly('account deletion')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiBearerAuth()
    @ApiOperation({
        summary: 'Delete the signed-in account',
        description: 'Requires the account email typed as `confirmEmail`. Signs the account out everywhere.',
    })
    async deleteMe(@Request() req: { user: { userId: string; email?: string | null } }, @Body() dto: DeleteMyAccountDto) {
        const preview = await this.deletion.preview(req.user.userId);
        const email = await this.deletion.emailOf(req.user.userId);
        if (!email || normaliseDeletionEmail(dto.confirmEmail) !== normaliseDeletionEmail(email)) {
            throw new ForbiddenException({
                message: 'Type the email address of this account to confirm.',
                code: 'confirmation_mismatch',
            });
        }
        try {
            const result = await this.deletion.execute(req.user.userId, { source: 'in_product' });
            return {
                deleted: true,
                accounts: result.accounts,
                workspacesDeleted: result.workspacesDeleted,
                worksDeleted: preview.worksDeleted,
            };
        } catch (error) {
            deletionFailed(error);
        }
    }
}

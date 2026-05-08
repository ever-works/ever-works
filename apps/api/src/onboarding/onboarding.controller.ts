import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
} from '@nestjs/common';
import { config } from '../config/constants';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import {
    RegisterWorkErrorDto,
    RegisterWorkRequestDto,
    RegisterWorkResponseDto,
} from './dto/register-work.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@Controller('api/register-work')
export class OnboardingController {
    constructor(private readonly onboarding: OnboardingService) {}

    @Public()
    @Post()
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Zero-friction registration: account + Work in one call',
        description:
            'Validates the GitHub credential against the named repo, creates an Ever Works ' +
            "account if one does not yet exist for the agent's GitHub identity, parses the " +
            '.works/works.yml manifest from the repo, and queues a Work for generation. Returns 202 ' +
            'with a status URL and the assigned subdomain. Subsequent calls with the same ' +
            '(github_identity, repo) return the same onboardingId without duplicating.',
    })
    @ApiHeader({
        name: 'X-GitHub-Token',
        required: true,
        description:
            'Fine-grained PAT, classic PAT, or GitHub App installation token. NEVER put this in the URL.',
    })
    @ApiHeader({
        name: 'Idempotency-Key',
        required: false,
        description: 'Optional UUID for safe retry (Stripe convention).',
    })
    @ApiBody({ type: RegisterWorkRequestDto })
    @ApiResponse({ status: 202, type: RegisterWorkResponseDto, description: 'Accepted' })
    @ApiResponse({ status: 400, type: RegisterWorkErrorDto, description: 'validation_error' })
    @ApiResponse({
        status: 403,
        type: RegisterWorkErrorDto,
        description: 'gh_repo_access_denied | gh_credential_invalid',
    })
    @ApiResponse({
        status: 409,
        type: RegisterWorkErrorDto,
        description: 'repo_already_owned | subdomain_taken',
    })
    @ApiResponse({
        status: 422,
        type: RegisterWorkErrorDto,
        description:
            'manifest_missing | manifest_invalid | unsupported_capability | gh_insufficient_scope_for_repo_creation',
    })
    @ApiResponse({ status: 429, type: RegisterWorkErrorDto, description: 'rate_limited' })
    @ApiResponse({ status: 500, type: RegisterWorkErrorDto, description: 'internal_error' })
    async register(
        @Body() body: RegisterWorkRequestDto,
        @Headers('x-github-token') githubToken: string,
        @Headers('idempotency-key') idempotencyKey?: string,
    ): Promise<RegisterWorkResponseDto> {
        if (!config.features.zeroFrictionOnboarding()) {
            throw new NotFoundException({
                statusCode: 404,
                code: 'feature_disabled',
                message: 'agent zero-friction onboarding is currently disabled',
            });
        }
        if (!githubToken) {
            throw new BadRequestException({
                statusCode: 400,
                code: 'validation_error',
                message: 'X-GitHub-Token header is required',
            });
        }
        const response = await this.onboarding.handle({ body, githubToken, idempotencyKey });
        return response as RegisterWorkResponseDto;
    }

    @Public()
    @Get(':id')
    @ApiOperation({
        summary: 'Status of an onboarding request',
        description:
            'Returns the latest status of a registration. Requires the same X-GitHub-Token used ' +
            'for the original registration to prevent enumeration.',
    })
    @ApiHeader({ name: 'X-GitHub-Token', required: true })
    @ApiResponse({ status: 200, type: RegisterWorkResponseDto })
    @ApiResponse({ status: 403, type: RegisterWorkErrorDto })
    @ApiResponse({ status: 404, type: RegisterWorkErrorDto })
    async status(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Headers('x-github-token') githubToken: string,
    ): Promise<RegisterWorkResponseDto> {
        const response = await this.onboarding.getStatus(id, githubToken);
        return response as RegisterWorkResponseDto;
    }
}

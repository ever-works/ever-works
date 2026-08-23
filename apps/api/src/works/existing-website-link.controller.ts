import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Put,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiConflictResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    ExistingWebsiteLinkDto,
    ExistingWebsiteLinkResponseDto,
} from './existing-website-link.dto';
import { ExistingWebsiteLinkService } from './existing-website-link.service';

@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class ExistingWebsiteLinkController {
    constructor(private readonly existingWebsiteLink: ExistingWebsiteLinkService) {}

    @Put('works/:id/existing-website')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Link an existing public website to a Work',
        description:
            'Registers an existing root HTTPS URL in the Work website and custom-domain records. ' +
            'This additive operation never deploys a website, configures DNS, contacts a deployment provider, or verifies the domain.',
    })
    @ApiParam({ name: 'id', format: 'uuid', description: 'Work ID' })
    @ApiOkResponse({ type: ExistingWebsiteLinkResponseDto })
    @ApiBadRequestResponse({ description: 'Missing active Organization or invalid website URL.' })
    @ApiNotFoundResponse({ description: 'Work not found in the active Organization.' })
    @ApiConflictResponse({ description: 'Work is already linked to a different website URL.' })
    async link(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ExistingWebsiteLinkDto,
    ): Promise<ExistingWebsiteLinkResponseDto> {
        return this.existingWebsiteLink.linkExistingWebsite(id, auth.userId, body.url);
    }
}

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OnboardingCatalogService } from './onboarding-catalog.service';
import { OnboardingCatalogResponseDto } from './dto/onboarding-state.dto';

/**
 * Returns the wizard catalog (AI / Storage / Deploy choice cards plus the
 * "Plugins & Integrations" list). The catalog is server-authoritative so we
 * can flip Ever Works defaults to / from "Planned" by toggling env flags
 * without shipping a web release.
 */
@ApiTags('onboarding')
@Controller('api/onboarding')
export class OnboardingCatalogController {
    constructor(private readonly catalogService: OnboardingCatalogService) {}

    @Get('catalog')
    @ApiOperation({ summary: 'Get the onboarding wizard catalog (cards + plugins)' })
    @ApiResponse({ status: 200, type: OnboardingCatalogResponseDto })
    getCatalog(): OnboardingCatalogResponseDto {
        return this.catalogService.getCatalog();
    }
}

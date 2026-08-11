import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { RequiredDocument } from 'terms-acceptance';
import { Public } from '../auth/decorators/public.decorator';
import { TermsAcceptanceService } from './terms-acceptance.service';

@ApiTags('terms')
// `api/terms`, not `terms`. There is no `setGlobalPrefix` in this app — every
// controller carries the `api/` segment itself (`@Controller('api')`,
// `@Controller('api/billing')`, …). This one did not, so it was served at
// `/terms/required` while every consumer reaches the API through the web's
// `API_URL`, which `constants.ts` guarantees ends in `/api`:
//
//     export const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;
//
// so `serverFetch('/terms/required')` asked for `/api/terms/required` and got a
// 404. The register page swallowed that, handed the form an empty document
// list, and the form correctly refused to let anyone accept terms it could not
// identify — disabling the checkbox and blocking every signup.
@Controller('api/terms')
export class TermsController {
    constructor(private readonly termsAcceptanceService: TermsAcceptanceService) {}

    /**
     * The legal documents a new account must accept, as currently published.
     *
     * Public by necessity — the signup form reads it before any account exists.
     *
     * Serving this rather than hard-coding versions in the client is what makes
     * the value that gates the submit button and the value that is posted back
     * the same object. Dropping it becomes a visible act rather than an
     * omission, which is how the checkbox came to be decorative in the first
     * place.
     */
    @Public()
    @Get('required')
    @ApiOperation({
        summary: 'List the legal documents a new account must accept',
        description:
            'Returns documentId, version, sha256 and locale per document, straight from the published legal corpus.',
    })
    @ApiResponse({ status: 200, description: 'Required documents' })
    getRequired(@Query('locale') locale?: string): RequiredDocument[] {
        return this.termsAcceptanceService.getRequiredDocuments(locale);
    }
}

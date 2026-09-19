import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AppSourceInspectResponse } from '@ever-works/contracts';
import { AppSourceInspectorService } from '@ever-works/agent/app-works';
import { AuthService, AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    AppSourceInspectRequestDto,
    AppSourceInspectResponseDto,
} from './dto/app-source-inspect.dto';

/**
 * APW-01 T17 — `POST /api/works/app-source/inspect` (plan §4.1,
 * `plan.md:465-490`).
 *
 * Spec: FR-5 … FR-10, FR-12, FR-56; ACC-01-06 (inspect writes nothing), ACC-01-13
 * (the instance setting refuses every client), ACC-01-26 (the call budget and the
 * unscanned owner).
 *
 * ## The controller decides nothing, and that is the task
 *
 * Everything this route answers — whether App Works are switched on at all
 * (Resolution R-6), whether the URL parses, which modes and deploy targets are
 * available, every reason code, the license class, the Blueprint match and the
 * `retryAfter` — is decided by `AppSourceInspectorService` (T12), which is the
 * same service the create path's step 6 calls. A second copy of any of those rules
 * here would be a second answer to the same question, and the two would drift the
 * first time one of them changed.
 *
 * What the route *adds* is what belongs to HTTP and to nothing else:
 *
 *   1. the **path and the verb** — a static `works/app-source/inspect`, three
 *      segments deep, so it cannot be shadowed by any `works/:id/...` handler
 *      (there is no `works/:id/inspect` route, and the spec pins that);
 *   2. **`200`, not `201`** — nothing is created. This is the one place the plan
 *      is explicit about the status code, because a provider-side refusal also
 *      answers `200` with the reasons the preview renders (a 404, an SSO wall, a
 *      rate limit or an empty repository is something the card must *show*, not an
 *      error of ours — only our own validation is a 4xx);
 *   3. **the session → user step** — `@CurrentUser()` carries the session's
 *      `userId`, and the inspection needs the `User` row (it is the cache key and
 *      the credential scope of every provider read), exactly as every other Works
 *      route resolves it;
 *   4. **the throttle** — `30` per minute per client. Inspect is called on a click
 *      and on Enter, never on a keystroke (the web form's rule), so the envelope is
 *      generous for a member and tight against a script that walks a URL list;
 *   5. **the OpenAPI description** of all of the above, including the error codes,
 *      because the MCP server and the web client are both written against it.
 *
 * ## Why there is no error translation here
 *
 * The inspector throws `BadRequestException`/`ServiceUnavailableException` whose
 * *body already is* §4.1's `{ status: 'error', code, message, details? }` — the
 * object is passed through Nest verbatim rather than re-rendered. So the codes the
 * plan's table fixes (`400 app_works_disabled`, `400 invalid_url`, `503
 * provider_not_connected`) reach the client as themselves, and `AppUpstreamController`
 * translates its own refusals only because *its* service throws a plain error.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class AppSourceController {
    constructor(
        private readonly inspector: AppSourceInspectorService,
        private readonly authService: AuthService,
    ) {}

    /**
     * Inspect a repository URL before an App Work is created from it.
     *
     * Writes nothing: no repository, no row, no Activity entry, no file (FR-5,
     * ACC-01-06). Every provider call behind it is a read.
     */
    @Post('works/app-source/inspect')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Inspect a repository before creating an App Work',
        description:
            'Answers everything the create form and the create path need about a pasted repository URL: the ' +
            'repository facts, whether the caller can push, which of Link / Fork / Private copy are available ' +
            'and why not when one is not, the accounts the caller can fork into (with the state of each ' +
            'existing-fork check), the Apps catalog Blueprint and how it matched, the license class, the ' +
            'deploy targets, and the caller’s own existing App Work. Inspect writes nothing. Provider-side ' +
            'refusals — a missing repository, an SSO wall, a restricted OAuth app, a rate limit, an empty ' +
            'repository — answer `200` with the reason codes on the modes, because the preview renders them; ' +
            'only our own validation answers `4xx`.',
    })
    @ApiResponse({
        status: 200,
        description:
            '`AppSourceInspectResponse` — the whole preview. Every mode and deploy target carries a reason ' +
            'code exactly when it is not available.',
        type: AppSourceInspectResponseDto,
    })
    @ApiResponse({
        status: 400,
        description:
            '`{ status: "error", code: "app_works_disabled", message }` when the instance setting is off ' +
            '(R-6 — refused before the URL is even parsed, for every client), or `code: "invalid_url"` when ' +
            'the URL does not parse or names a different provider than `gitProvider`.',
    })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({
        status: 429,
        description: 'Our own throttle (30 per minute) — Nest’s throttler default body.',
    })
    @ApiResponse({
        status: 503,
        description:
            '`{ status: "error", code: "provider_not_connected", message }` when no git provider is ' +
            'available in this installation, so repositories cannot be read at all.',
    })
    async inspect(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: AppSourceInspectRequestDto,
    ): Promise<AppSourceInspectResponse> {
        const user = await this.authService.getUser(auth.userId);

        return this.inspector.inspect(dto.repositoryUrl, user, {
            // Only the fields the member actually sent travel on, so the service's
            // own defaults (no provider check, no catalog pick) stay in force.
            ...(dto.gitProvider ? { gitProvider: dto.gitProvider } : {}),
            ...(dto.blueprintId ? { blueprintId: dto.blueprintId } : {}),
        });
    }
}

import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    ServiceUnavailableException,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AiFacadeService, TranscriptionNotConfiguredError } from '@ever-works/agent/facades';
import { PluginOperationsService } from '@ever-works/agent/plugins';
import { config } from '@ever-works/agent/config';
import { AuthSessionGuard, CurrentUser } from '../../auth';
import { AuthenticatedUser } from '../../auth/types/auth.types';

/**
 * Speech-to-text for interactive use — voice dictation in chat.
 *
 * The transcription capability already existed and was already wired to
 * every AI-provider plugin that implements it; the only consumer was KB
 * media ingest, which reaches it from a background job. There was no way
 * for a user-facing surface to ask for a transcript, which is why chat
 * had no dictation. This adds that door and nothing else — provider
 * selection, the operator pin, and the not-configured error all keep the
 * behaviour the ingest path already relies on.
 */

const AUDIO_MAX_BYTES = Number(process.env.TRANSCRIBE_MAX_BYTES) || 25 * 1024 * 1024;

/**
 * Formats a browser `MediaRecorder` actually produces, plus the common
 * upload formats. Anything else is rejected before it reaches a provider
 * — an allow-list rather than a deny-list, because this forwards user
 * bytes to a paid third-party API.
 */
const ALLOWED_AUDIO_MIMES = new Set([
    'audio/webm',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/flac',
]);

export class TranscribeDto {
    /** BCP-47 hint. Providers detect the language when this is omitted. */
    @IsOptional()
    @IsString()
    @MaxLength(35)
    language?: string;

    /**
     * Explicit provider for this call — the narrowest level of the
     * resolution chain, so a user (or a per-account setting in the UI)
     * can pick B instead of A without touching deployment config.
     *
     * Omit it and selection falls through to the operator default, then
     * to whichever AI-provider plugin is ACTIVATED for this scope. See
     * `resolveProviderId` for the whole order.
     */
    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(/^[a-z0-9-]+$/, {
        message: 'providerId must be a plugin id (lowercase, digits, hyphens)',
    })
    providerId?: string;
}

@ApiTags('Transcription')
@ApiBearerAuth('JWT-auth')
@Controller('api/transcription')
@UseGuards(AuthSessionGuard)
export class TranscriptionController {
    private readonly logger = new Logger(TranscriptionController.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly pluginOperations: PluginOperationsService,
    ) {}

    /**
     * The platform-wide default voice provider, if an operator set one.
     *
     * This is a DEFAULT, not a pin: it is handed to the facade as
     * `fallbackProviderId`, which only applies once scope resolution has
     * failed to produce a transcription-capable plugin. A tenant that
     * activates a voice plugin therefore overrides it, which is how every
     * other setting in this platform resolves (work > user > admin > env
     * > defaults — env is near the BOTTOM, not the top).
     *
     * The earlier version passed this as `providerOverride`, which skips
     * the entire chain. One operator env var then silently beat every
     * tenant's own activated plugin.
     */
    private defaultProviderId(): string | undefined {
        const global = process.env.TRANSCRIPTION_PROVIDER_ID;
        if (global && global.length > 0) return global;
        return config.kb.getTranscriptionProviderId();
    }

    @Get('providers')
    @ApiOperation({
        summary: 'Voice providers available in this scope',
        description:
            'AI-provider plugins that implement `transcribe()`, so the client can offer a choice rather than assume a vendor. `isActive` marks the one this scope resolves to by default. Capability is probed on the plugin instance because `transcribe` is optional on the AI-provider interface — being an AI provider does not imply speech-to-text.',
    })
    @ApiResponse({ status: 200, description: '{ providers: [{ id, name, isActive }] }' })
    async listProviders(@CurrentUser() auth: AuthenticatedUser) {
        const [providers, selectedDefault] = await Promise.all([
            this.aiFacade.listTranscriptionProviders({ userId: auth.userId }),
            this.pluginOperations.getGlobalVoiceDefault(auth.userId),
        ]);
        // `selectedDefault` is the account's own pick (Settings → Plugins → AI
        // Providers) and is what the settings UI renders as selected;
        // `configuredDefault` remains the operator's env-level fallback, which
        // only applies when the account has expressed no preference.
        return {
            providers,
            selectedDefault,
            configuredDefault: this.defaultProviderId() ?? null,
        };
    }

    @Post()
    @HttpCode(HttpStatus.OK)
    // Tighter than the other capability routes on purpose: every call
    // spends money at a third-party provider and is triggered by a single
    // user gesture, so a runaway client should be stopped early.
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AUDIO_MAX_BYTES } }))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
        summary: 'Transcribe an audio clip to text',
        description:
            'Multipart speech-to-text for interactive dictation. Provider resolution is layered most-specific-first, so a vendor can be swapped without a code change: an explicit `providerId` on the request wins, then the AI-provider plugin ACTIVATED for this scope, then the platform default (`TRANSCRIPTION_PROVIDER_ID`, falling back to `KB_TRANSCRIPTION_PROVIDER_ID`), then any registered plugin implementing transcribe. Env is a DEFAULT, not a pin — a tenant that activates a voice plugin overrides it. Returns 503 when nothing offers transcription, so the client can hide the control rather than fail silently.',
    })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['file'],
            properties: {
                file: { type: 'string', format: 'binary' },
                language: { type: 'string' },
                providerId: { type: 'string' },
            },
        },
    })
    @ApiResponse({ status: 200, description: '{ text, model, language?, durationSeconds? }' })
    @ApiResponse({ status: 400, description: 'Missing file or unsupported audio format' })
    @ApiResponse({ status: 503, description: 'No transcription-capable provider configured' })
    async transcribe(
        @CurrentUser() auth: AuthenticatedUser,
        @UploadedFile() file: Express.Multer.File | undefined,
        @Body() body: TranscribeDto,
    ) {
        if (!file) {
            throw new BadRequestException({
                status: 'error',
                message: "Multipart field 'file' is required",
            });
        }

        // `audio/webm;codecs=opus` is what Chrome hands back — compare the
        // base type so the codec parameter does not fail the allow-list.
        const baseMime = (file.mimetype ?? '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_AUDIO_MIMES.has(baseMime)) {
            throw new BadRequestException({
                status: 'error',
                message: `Unsupported audio format '${baseMime || 'unknown'}'`,
            });
        }

        // The account's Settings choice acts exactly like an explicit
        // per-request pick, because it IS one — just made once, in the place
        // where swapping speech vendors belongs, instead of re-made beside
        // every message. An explicit `providerId` on the request still wins,
        // so API clients and future surfaces keep the narrower lever.
        const selectedProviderId =
            body.providerId ?? (await this.pluginOperations.getGlobalVoiceDefault(auth.userId));

        try {
            const result = await this.aiFacade.transcribe(
                {
                    file: file.buffer,
                    filename: file.originalname || 'dictation.webm',
                    language: body.language || config.kb.getTranscriptionLanguage(),
                },
                {
                    userId: auth.userId,
                    // Only an explicit pick (per-request, or the account's
                    // saved one) pins a provider. Everything else flows
                    // through the facade's chain so tenant activation keeps
                    // its precedence.
                    providerOverride: selectedProviderId ?? undefined,
                },
                { fallbackProviderId: this.defaultProviderId() },
            );

            return {
                text: result.text,
                model: result.model,
                language: result.language,
                durationSeconds: result.durationSeconds,
            };
        } catch (error) {
            if (error instanceof TranscriptionNotConfiguredError) {
                // A deployment with no Whisper-capable provider is a
                // configuration state, not a bug — 503 lets the client
                // hide the mic rather than show a broken button.
                throw new ServiceUnavailableException({
                    status: 'error',
                    message: 'No transcription-capable AI provider is configured',
                });
            }
            // Never surface a raw provider error to the client: it can
            // carry request ids, key fragments and upstream URLs.
            //
            // And do not LOG it either. A provider 401 routinely echoes
            // the offending credential back in its message, so
            // `String(error)` here would write a live API key into the
            // application logs — a worse leak than the response would
            // have been, because logs are shipped and retained. The
            // error class is enough to tell operators what broke; the
            // provider's own dashboard holds the detail.
            this.logger.warn(
                `Transcription failed for user=${auth.userId} (${
                    (error as Error)?.name ?? 'Error'
                })`,
            );
            throw new ServiceUnavailableException({
                status: 'error',
                message: 'Transcription failed',
            });
        }
    }
}

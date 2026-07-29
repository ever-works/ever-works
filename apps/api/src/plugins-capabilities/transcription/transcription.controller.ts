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

    constructor(private readonly aiFacade: AiFacadeService) {}

    /**
     * Which voice provider handles this call.
     *
     * Deliberately layered the same way every other pluggable capability
     * in the platform is, so swapping B for A never requires a code
     * change:
     *
     *   1. `providerId` on the request — a per-user / per-account choice
     *      made in the UI, narrowest and therefore highest precedence.
     *   2. `TRANSCRIPTION_PROVIDER_ID` — a global operator default for
     *      interactive dictation.
     *   3. `KB_TRANSCRIPTION_PROVIDER_ID` — honoured for continuity with
     *      the KB media-ingest pin, which was the only transcription
     *      setting that existed before this endpoint.
     *   4. `undefined` — hand the decision to the facade, which uses the
     *      AI-provider plugin ACTIVATED for this scope and then any
     *      registered plugin implementing `transcribe()`.
     *
     * Step 4 is the important one and the reason this returns undefined
     * rather than a hardcoded id: with nothing configured anywhere, the
     * activated plugin wins. The previous version always passed the KB
     * env pin, which meant a deployment that had pinned a provider for
     * media ingest silently forced the same vendor on chat dictation and
     * a tenant could not choose otherwise.
     */
    private resolveProviderId(requested?: string): string | undefined {
        if (requested) return requested;
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
        const providers = await this.aiFacade.listTranscriptionProviders({
            userId: auth.userId,
        });
        return { providers, configuredDefault: this.resolveProviderId() ?? null };
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
            'Multipart speech-to-text for interactive dictation. Provider resolution is layered so a vendor can be swapped without a code change: `providerId` on the request (per-user choice) wins, then `TRANSCRIPTION_PROVIDER_ID`, then `KB_TRANSCRIPTION_PROVIDER_ID`, and otherwise the AI-provider plugin ACTIVATED for this scope. Returns 503 when nothing offers transcription, so the client can hide the control rather than fail silently.',
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

        try {
            const result = await this.aiFacade.transcribe(
                {
                    file: file.buffer,
                    filename: file.originalname || 'dictation.webm',
                    language: body.language || config.kb.getTranscriptionLanguage(),
                },
                {
                    userId: auth.userId,
                    providerOverride: this.resolveProviderId(body.providerId),
                },
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

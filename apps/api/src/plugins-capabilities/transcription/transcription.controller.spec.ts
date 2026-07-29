jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionNotConfiguredError } from '@ever-works/agent/facades';
import type { AiFacadeService } from '@ever-works/agent/facades';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

/**
 * `POST /api/transcription`.
 *
 * Three contracts worth pinning:
 *
 *   - the audio MIME allow-list, because this forwards user bytes to a
 *     paid third-party API and `audio/webm;codecs=opus` (what Chrome
 *     actually produces) must pass it;
 *   - `TranscriptionNotConfiguredError` becomes a 503, which is the
 *     signal the client uses to hide the mic rather than show a control
 *     that can only fail;
 *   - a provider error never reaches the client verbatim — those
 *     messages carry request ids, upstream URLs and sometimes key
 *     fragments.
 */
describe('TranscriptionController', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;

    const clip = (mimetype: string): Express.Multer.File =>
        ({
            buffer: Buffer.from('fake-audio'),
            originalname: 'dictation.webm',
            mimetype,
            size: 10,
        }) as Express.Multer.File;

    let aiFacade: { transcribe: jest.Mock; listTranscriptionProviders: jest.Mock };
    let controller: TranscriptionController;

    beforeEach(() => {
        aiFacade = {
            transcribe: jest.fn().mockResolvedValue({ text: 'hello world', model: 'whisper-1' }),
            listTranscriptionProviders: jest.fn().mockResolvedValue([
                { id: 'openai', name: 'OpenAI', isActive: true },
                { id: 'groq', name: 'Groq', isActive: false },
            ]),
        };
        delete process.env.TRANSCRIPTION_PROVIDER_ID;
        delete process.env.KB_TRANSCRIPTION_PROVIDER_ID;
        controller = new TranscriptionController(aiFacade as unknown as AiFacadeService);
    });

    afterEach(() => jest.restoreAllMocks());

    it('rejects a request with no file', async () => {
        await expect(controller.transcribe(auth, undefined, {})).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(aiFacade.transcribe).not.toHaveBeenCalled();
    });

    it("accepts the codec-parameterised MIME a browser's MediaRecorder emits", async () => {
        const res = await controller.transcribe(auth, clip('audio/webm;codecs=opus'), {});

        expect(res.text).toBe('hello world');
        expect(aiFacade.transcribe).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-audio upload before it reaches a provider', async () => {
        await expect(
            controller.transcribe(auth, clip('application/x-msdownload'), {}),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(aiFacade.transcribe).not.toHaveBeenCalled();
    });

    it('maps a missing transcription provider to 503 so the client can hide the control', async () => {
        aiFacade.transcribe.mockRejectedValue(
            new TranscriptionNotConfiguredError('no provider', 'openai'),
        );

        await expect(controller.transcribe(auth, clip('audio/webm'), {})).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });

    it('does not leak a raw provider error to the client', async () => {
        aiFacade.transcribe.mockRejectedValue(
            new Error('401 from https://api.vendor.test/v1/audio key=sk-live-abc123'),
        );

        await expect(controller.transcribe(auth, clip('audio/webm'), {})).rejects.toThrow(
            /Transcription failed/,
        );
        await expect(controller.transcribe(auth, clip('audio/webm'), {})).rejects.not.toThrow(
            /sk-live/,
        );
    });

    it('does not write the provider error into the logs either', async () => {
        // A provider 401 routinely echoes the offending credential back
        // in its message. Logging `String(error)` would put a live key
        // into shipped, retained logs — a worse leak than the response.
        const warn = jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
        aiFacade.transcribe.mockRejectedValue(
            new Error('401 from https://api.vendor.test/v1/audio key=sk-live-abc123'),
        );

        await expect(controller.transcribe(auth, clip('audio/webm'), {})).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );

        expect(warn).toHaveBeenCalledTimes(1);
        const logged = String(warn.mock.calls[0][0]);
        expect(logged).not.toMatch(/sk-live/);
        expect(logged).not.toMatch(/api\.vendor\.test/);
    });

    it('scopes the call to the calling user', async () => {
        await controller.transcribe(auth, clip('audio/webm'), {});

        expect(aiFacade.transcribe).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'dictation.webm' }),
            expect.objectContaining({ userId: 'user-1' }),
            // Third arg carries the lower-precedence platform default.
            expect.any(Object),
        );
    });

    describe('provider resolution — tenant activation outranks the env default', () => {
        afterEach(() => {
            delete process.env.TRANSCRIPTION_PROVIDER_ID;
            delete process.env.KB_TRANSCRIPTION_PROVIDER_ID;
        });

        it('pins nothing when the caller expressed no preference', async () => {
            await controller.transcribe(auth, clip('audio/webm'), {});

            // No pin => the facade resolves the plugin activated for this
            // scope on its own.
            expect(aiFacade.transcribe.mock.calls[0][1].providerOverride).toBeUndefined();
        });

        it('passes the env value as a FALLBACK, never as a pin', async () => {
            // The distinction is the whole point. `providerOverride`
            // short-circuits the facade's chain, so an env var passed
            // there would beat every tenant's activated plugin.
            // `fallbackProviderId` applies only after scope resolution
            // finds nothing capable.
            process.env.TRANSCRIPTION_PROVIDER_ID = 'groq';

            await controller.transcribe(auth, clip('audio/webm'), {});

            const [, facadeOptions, selection] = aiFacade.transcribe.mock.calls[0];
            expect(facadeOptions.providerOverride).toBeUndefined();
            expect(selection).toEqual({ fallbackProviderId: 'groq' });
        });

        it('lets an explicit per-request pick pin the provider', async () => {
            process.env.TRANSCRIPTION_PROVIDER_ID = 'groq';

            await controller.transcribe(auth, clip('audio/webm'), { providerId: 'openai' });

            expect(aiFacade.transcribe.mock.calls[0][1].providerOverride).toBe('openai');
        });

        it('prefers the dictation env default over the KB ingest pin', async () => {
            process.env.KB_TRANSCRIPTION_PROVIDER_ID = 'kb-pinned';
            await controller.transcribe(auth, clip('audio/webm'), {});
            expect(aiFacade.transcribe.mock.calls[0][2]).toEqual({
                fallbackProviderId: 'kb-pinned',
            });

            process.env.TRANSCRIPTION_PROVIDER_ID = 'groq';
            await controller.transcribe(auth, clip('audio/webm'), {});
            expect(aiFacade.transcribe.mock.calls[1][2]).toEqual({ fallbackProviderId: 'groq' });
        });

        it('lists only providers that actually implement transcribe', async () => {
            const res = await controller.listProviders(auth);

            expect(res.providers.map((p: { id: string }) => p.id)).toEqual(['openai', 'groq']);
            expect(res.providers.find((p: { isActive: boolean }) => p.isActive)?.id).toBe('openai');
        });
    });
});

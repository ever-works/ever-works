jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));
// EW-641 Phase 2/c row 34c — `OpenAiCompatService` now imports the
// agent/services barrel for KB mention injection. Stub it here to
// keep the controller spec free of agent transitive deps.
jest.mock('@ever-works/agent/services', () => ({
    KbMentionResolverService: class {},
    parseKbMentions: jest.fn().mockReturnValue([]),
    formatKbContext: jest.fn().mockReturnValue('<kb>\n</kb>'),
}));

import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe('OpenAiCompatController', () => {
    let controller: OpenAiCompatController;
    let service: jest.Mocked<
        Pick<OpenAiCompatService, 'handleCompletion' | 'handleStreamingCompletion'>
    >;
    let res: jest.Mocked<{
        setHeader: (name: string, value: string) => void;
        json: (body: unknown) => void;
        write: (chunk: string) => void;
        end: (payload?: string) => void;
        headersSent: boolean;
        destroyed: boolean;
        writableEnded: boolean;
        status: (code: number) => void;
        destroy: (error?: Error) => void;
    }>;
    const auth: AuthenticatedUser = { userId: 'user-1' } as AuthenticatedUser;

    beforeEach(() => {
        service = {
            handleCompletion: jest.fn(),
            handleStreamingCompletion: jest.fn().mockResolvedValue(undefined),
        } as any;
        res = {
            setHeader: jest.fn(),
            json: jest.fn(),
            write: jest.fn(),
            end: jest.fn(),
            status: jest.fn(),
            destroy: jest.fn(),
            headersSent: false,
            destroyed: false,
            writableEnded: false,
        };
        controller = new OpenAiCompatController(service as unknown as OpenAiCompatService);
    });

    it('streaming branch sets SSE headers and delegates to handleStreamingCompletion', async () => {
        const body = { stream: true, messages: [], model: 'auto' } as any;

        await controller.chatCompletions(auth, 'p-override', 'w-1', body, res);

        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
        expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
        expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
        expect(service.handleStreamingCompletion).toHaveBeenCalledWith(
            body,
            { userId: 'user-1', workId: 'w-1', providerOverride: 'p-override' },
            res,
        );
        expect(service.handleCompletion).not.toHaveBeenCalled();
    });

    it('non-streaming branch returns JSON via res.json', async () => {
        const body = { stream: false, messages: [] } as any;
        const result = { id: 'r-1' } as any;
        service.handleCompletion.mockResolvedValue(result);

        await controller.chatCompletions(auth, undefined, undefined, body, res);

        expect(service.handleCompletion).toHaveBeenCalledWith(body, {
            userId: 'user-1',
            workId: undefined,
            providerOverride: undefined,
        });
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        expect(res.json).toHaveBeenCalledWith(result);
        expect(service.handleStreamingCompletion).not.toHaveBeenCalled();
    });

    it('treats missing stream flag as non-streaming', async () => {
        const body = { messages: [] } as any;
        service.handleCompletion.mockResolvedValue({} as any);

        await controller.chatCompletions(auth, undefined, undefined, body, res);

        expect(service.handleCompletion).toHaveBeenCalled();
        expect(service.handleStreamingCompletion).not.toHaveBeenCalled();
    });

    it('forwards optional headers through facadeOptions', async () => {
        const body = { stream: false, messages: [] } as any;
        service.handleCompletion.mockResolvedValue({} as any);

        await controller.chatCompletions(auth, 'override-x', 'work-99', body, res);

        expect(service.handleCompletion).toHaveBeenCalledWith(body, {
            userId: 'user-1',
            workId: 'work-99',
            providerOverride: 'override-x',
        });
    });
});

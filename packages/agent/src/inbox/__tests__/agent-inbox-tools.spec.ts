import { buildInboxTools } from '../agent-inbox-tools';

/**
 * The `ask_human` chat tool. What matters here is the CONTRACT with the
 * model: the tool exists under a stable name, the run/agent links come
 * from the bound run context (never from the arguments), and the result
 * tells the model in words that the run is now parked — otherwise the
 * model keeps looping instead of ending its turn.
 */
describe('buildInboxTools — ask_human', () => {
    function build(agentRunId: string | null = 'run-1') {
        const service = {
            askHuman: jest.fn(
                async (
                    _userId: string,
                    _input: { question: string; options?: unknown; context?: string | null },
                    _source: { agentId: string; agentRunId?: string | null },
                ) => ({
                    item: { id: 'i1' } as never,
                    parked: agentRunId !== null,
                }),
            ),
        };
        const [tool] = buildInboxTools({
            userId: 'u1',
            agentId: 'a1',
            agentRunId,
            service: service as never,
        });
        return { tool, service };
    }

    it('registers exactly one tool named ask_human with question required', () => {
        const tools = buildInboxTools({
            userId: 'u1',
            agentId: 'a1',
            agentRunId: null,
            service: { askHuman: jest.fn() } as never,
        });
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('ask_human');
        expect(tools[0].parameters.required).toEqual(['question']);
    });

    it('binds userId/agentId/runId from the build args, not from the model', async () => {
        const { tool, service } = build('run-1');
        await tool.invoke({
            question: 'Postgres or SQLite?',
            // A prompt-injected agent trying to redirect the question:
            userId: 'victim',
            agentRunId: 'someone-elses-run',
        } as never);

        expect(service.askHuman).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ question: 'Postgres or SQLite?' }),
            { agentId: 'a1', agentRunId: 'run-1' },
        );
    });

    it('tells the model the run is parked and to end its turn', async () => {
        const { tool } = build('run-1');
        const result = (await tool.invoke({ question: 'Which one?' } as never)) as {
            asked: boolean;
            parked: boolean;
            inboxItemId: string;
            message: string;
        };

        expect(result).toMatchObject({ asked: true, parked: true, inboxItemId: 'i1' });
        expect(result.message).toContain('parked');
    });

    it('says so honestly when the run could not be parked', async () => {
        const { tool } = build(null);
        const result = (await tool.invoke({ question: 'Which one?' } as never)) as {
            parked: boolean;
            message: string;
        };

        expect(result.parked).toBe(false);
        expect(result.message).toContain('could not be parked');
    });

    it('forwards structured options through to the service', async () => {
        const { tool, service } = build('run-1');
        await tool.invoke({
            question: 'Pick',
            options: [{ id: 'a', label: 'A' }],
        } as never);

        expect(service.askHuman.mock.calls[0][1]).toMatchObject({
            options: [{ id: 'a', label: 'A' }],
        });
    });

    it('refuses an empty question without touching the service', async () => {
        const { tool, service } = build('run-1');
        const result = await tool.invoke({ question: '  ' } as never);

        expect(result).toEqual({ error: 'ask_human: question is required.' });
        expect(service.askHuman).not.toHaveBeenCalled();
    });

    it('returns the failure as a tool error instead of throwing into the loop', async () => {
        const service = {
            askHuman: jest.fn(async () => {
                throw new Error('db down');
            }),
        };
        const [tool] = buildInboxTools({
            userId: 'u1',
            agentId: 'a1',
            agentRunId: 'run-1',
            service: service as never,
        });

        await expect(tool.invoke({ question: 'Which one?' } as never)).resolves.toEqual({
            error: 'db down',
        });
    });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwitchAiSubCommand } from '../switch-ai.subcommand';

const m = (fn: any) => fn as ReturnType<typeof vi.fn>;

interface ConfigStub {
    loadConfig: ReturnType<typeof vi.fn>;
}

function makeStub(): ConfigStub {
    return { loadConfig: vi.fn() };
}

describe('SwitchAiSubCommand', () => {
    let stub: ConfigStub;
    let cmd: SwitchAiSubCommand;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        stub = makeStub();
        cmd = new SwitchAiSubCommand(stub as unknown as any);
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        vi.restoreAllMocks();
    });

    describe('run', () => {
        it('logs the no-config message when loadConfig returns null', async () => {
            stub.loadConfig.mockResolvedValue(null);
            await cmd.run([], {});
            const logged = logSpy.mock.calls
                .map((c) => String(c[0]))
                // eslint-disable-next-line no-control-regex
                .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
                .join('\n');
            expect(logged).toContain('No configuration found');
        });

        it('lists each configured provider with a green checkmark', async () => {
            stub.loadConfig.mockResolvedValue({
                PLUGIN_OPENROUTER_API_KEY: 'sk-or-x',
                PLUGIN_OPENAI_API_KEY: 'sk-x',
            });

            await cmd.run([], {});

            const logged = logSpy.mock.calls
                .map((c) => String(c[0]))
                // eslint-disable-next-line no-control-regex
                .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
                .join('\n');
            expect(logged).toContain('openrouter');
            expect(logged).toContain('openai');
            expect(logged).not.toContain('google');
        });

        it('treats Ollama specially — recognized via PLUGIN_OLLAMA_BASE_URL even without API key', async () => {
            stub.loadConfig.mockResolvedValue({
                PLUGIN_OLLAMA_BASE_URL: 'http://localhost:11434',
            });

            await cmd.run([], {});

            const logged = logSpy.mock.calls
                .map((c) => String(c[0]))
                // eslint-disable-next-line no-control-regex
                .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
                .join('\n');
            expect(logged).toContain('ollama');
        });

        it('logs the no-AI-providers message when config exists but no providers are set', async () => {
            stub.loadConfig.mockResolvedValue({
                GIT_TOKEN: 't',
                GIT_OWNER: 'o',
            });

            await cmd.run([], {});

            const logged = logSpy.mock.calls
                .map((c) => String(c[0]))
                // eslint-disable-next-line no-control-regex
                .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
                .join('\n');
            expect(logged).toContain('No AI provider plugins configured');
        });

        it('logs an error message via console.log when loadConfig throws', async () => {
            stub.loadConfig.mockRejectedValue(new Error('disk error'));
            await cmd.run([], {});
            // The catch path uses console.log with two args: the chalk-red header
            // AND the raw error.message — so we collect ALL args from every call.
            const logged = logSpy.mock.calls
                .flat()
                .map((arg) => String(arg))
                // eslint-disable-next-line no-control-regex
                .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
                .join('\n');
            expect(logged).toContain('Failed to list AI providers');
            expect(logged).toContain('disk error');
        });

        it('detects all six provider keys via PLUGIN_<NAME>_API_KEY', async () => {
            stub.loadConfig.mockResolvedValue({
                PLUGIN_OPENROUTER_API_KEY: 'k',
                PLUGIN_OPENAI_API_KEY: 'k',
                PLUGIN_GOOGLE_API_KEY: 'k',
                PLUGIN_ANTHROPIC_API_KEY: 'k',
                PLUGIN_GROQ_API_KEY: 'k',
                PLUGIN_OLLAMA_BASE_URL: 'http://ollama',
            });

            await cmd.run([], {});
            const logged = logSpy.mock.calls
                .map((c) => String(c[0]))
                // eslint-disable-next-line no-control-regex
                .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
                .join('\n');
            for (const name of ['openrouter', 'openai', 'google', 'anthropic', 'groq', 'ollama']) {
                expect(logged).toContain(name);
            }
        });
    });
});

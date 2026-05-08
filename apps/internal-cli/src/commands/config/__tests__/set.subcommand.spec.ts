import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SetSubCommand } from '../set.subcommand';

interface ConfigStub {
    loadConfig: ReturnType<typeof vi.fn>;
    saveConfig: ReturnType<typeof vi.fn>;
}

function makeStub(): ConfigStub {
    return {
        loadConfig: vi.fn().mockResolvedValue({}),
        saveConfig: vi.fn().mockResolvedValue(undefined),
    };
}

describe('SetSubCommand.run (validation paths)', () => {
    let stub: ConfigStub;
    let cmd: SetSubCommand;
    let logSpy: ReturnType<typeof vi.spyOn>;

    const stripAnsi = (s: string): string => {
        // eslint-disable-next-line no-control-regex
        return s.replace(/\x1b\[[0-9;]*m/g, '');
    };

    const captured = (): string =>
        logSpy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .map(stripAnsi)
            .join('\n');

    beforeEach(() => {
        vi.clearAllMocks();
        stub = makeStub();
        cmd = new SetSubCommand(stub as unknown as any);
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('refuses when fewer than 2 positional params are passed', async () => {
        await cmd.run([], {});
        await cmd.run(['ONLY_KEY'], {});
        expect(captured()).toContain('Both key and value are required');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses an invalid (non-uppercase) key format', async () => {
        await cmd.run(['lowercaseKey', 'value'], {});
        expect(captured()).toContain('Invalid configuration key');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses keys with leading underscore or digit', async () => {
        await cmd.run(['_LEADING', 'value'], {});
        await cmd.run(['1NUMERIC', 'value'], {});
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('rejects an unknown AI_DEFAULT_PROVIDER value', async () => {
        await cmd.run(['AI_DEFAULT_PROVIDER', 'unknownai'], {});
        expect(captured()).toContain('Invalid value for AI_DEFAULT_PROVIDER');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('accepts each documented AI provider value (case-insensitive)', async () => {
        for (const v of [
            'openai',
            'OpenAI',
            'GOOGLE',
            'anthropic',
            'openrouter',
            'ollama',
            'groq',
            'custom',
        ]) {
            stub.saveConfig.mockClear();
            await cmd.run(['AI_DEFAULT_PROVIDER', v], {});
            expect(stub.saveConfig).toHaveBeenCalledTimes(1);
        }
    });

    it('rejects an unknown EXTRACT_CONTENT_SERVICE value', async () => {
        await cmd.run(['EXTRACT_CONTENT_SERVICE', 'wrong'], {});
        expect(captured()).toContain('Invalid content extraction service');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('accepts EXTRACT_CONTENT_SERVICE = tavily | local', async () => {
        for (const v of ['tavily', 'local']) {
            stub.saveConfig.mockClear();
            await cmd.run(['EXTRACT_CONTENT_SERVICE', v], {});
            expect(stub.saveConfig).toHaveBeenCalledTimes(1);
        }
    });

    it('rejects an unknown WEB_SEARCH_SERVICE value (only "tavily" allowed)', async () => {
        await cmd.run(['WEB_SEARCH_SERVICE', 'google'], {});
        expect(captured()).toContain('Invalid web search service');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('accepts WEB_SEARCH_SERVICE = tavily', async () => {
        await cmd.run(['WEB_SEARCH_SERVICE', 'tavily'], {});
        expect(stub.saveConfig).toHaveBeenCalledTimes(1);
    });

    it('rejects an out-of-range _TEMPERATURE value', async () => {
        await cmd.run(['OPENAI_TEMPERATURE', '5'], {});
        expect(captured()).toContain('Temperature must be a number');
        await cmd.run(['OPENAI_TEMPERATURE', '-1'], {});
        await cmd.run(['OPENAI_TEMPERATURE', 'abc'], {});
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('accepts a valid temperature in [0, 2]', async () => {
        await cmd.run(['OPENAI_TEMPERATURE', '0.7'], {});
        await cmd.run(['OPENAI_TEMPERATURE', '2'], {});
        await cmd.run(['OPENAI_TEMPERATURE', '0'], {});
        expect(stub.saveConfig).toHaveBeenCalledTimes(3);
    });

    it('rejects an out-of-range _MAX_TOKENS value', async () => {
        await cmd.run(['OPENAI_MAX_TOKENS', '0'], {});
        await cmd.run(['OPENAI_MAX_TOKENS', '500000'], {});
        await cmd.run(['OPENAI_MAX_TOKENS', 'abc'], {});
        expect(captured()).toContain('Max tokens must be a number');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('accepts a valid _MAX_TOKENS', async () => {
        await cmd.run(['OPENAI_MAX_TOKENS', '4096'], {});
        expect(stub.saveConfig).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid URL for _BASE_URL keys', async () => {
        await cmd.run(['OLLAMA_BASE_URL', 'not-a-url'], {});
        expect(captured()).toContain('Invalid URL format');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('accepts a valid URL for _BASE_URL keys', async () => {
        await cmd.run(['OLLAMA_BASE_URL', 'http://localhost:11434'], {});
        expect(stub.saveConfig).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed GIT_EMAIL', async () => {
        await cmd.run(['GIT_EMAIL', 'not-an-email'], {});
        expect(captured()).toContain('Invalid email format');
        expect(stub.saveConfig).not.toHaveBeenCalled();
    });

    it('accepts a valid GIT_EMAIL', async () => {
        await cmd.run(['GIT_EMAIL', 'me@example.com'], {});
        expect(stub.saveConfig).toHaveBeenCalledTimes(1);
        const writtenCfg = stub.saveConfig.mock.calls[0][0];
        expect(writtenCfg).toEqual({ GIT_EMAIL: 'me@example.com' });
    });

    it('joins multi-word values into a single space-separated string', async () => {
        await cmd.run(['GIT_NAME', 'John', 'Doe'], {});
        const writtenCfg = stub.saveConfig.mock.calls[0][0];
        expect(writtenCfg).toEqual({ GIT_NAME: 'John Doe' });
    });

    it('merges new key/value onto the existing config (does not clobber unrelated keys)', async () => {
        stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 'old', GIT_OWNER: 'me' });
        await cmd.run(['GIT_NAME', 'NewName'], {});
        expect(stub.saveConfig).toHaveBeenCalledWith({
            GIT_TOKEN: 'old',
            GIT_OWNER: 'me',
            GIT_NAME: 'NewName',
        });
    });

    it('masks API key values in the success log (head + tail visible, middle starred)', async () => {
        await cmd.run(['PLUGIN_OPENAI_API_KEY', 'sk-abcdefghijklmnop'], {});
        const out = captured();
        // head 4 + 8 stars + tail 4
        expect(out).toContain('sk-a');
        expect(out).toContain('mnop');
        // The original full key MUST NOT appear in clear text
        expect(out).not.toContain('sk-abcdefghijklmnop');
    });

    it('does NOT mask short values (length<=8) for API key keys', async () => {
        await cmd.run(['PLUGIN_OPENAI_API_KEY', 'short'], {});
        const out = captured();
        expect(out).toContain('= short');
    });

    it('does not throw and logs an error when configService.saveConfig rejects', async () => {
        stub.saveConfig.mockRejectedValue(new Error('disk full'));
        await cmd.run(['GIT_NAME', 'OK'], {});
        expect(captured()).toContain('Failed to set configuration');
        expect(captured()).toContain('disk full');
    });
});

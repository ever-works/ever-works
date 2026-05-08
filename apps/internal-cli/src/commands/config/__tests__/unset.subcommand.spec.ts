import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('inquirer', () => ({
    default: { prompt: vi.fn(), Separator: class Separator {} },
}));

import inquirer from 'inquirer';
import { UnsetSubCommand } from '../unset.subcommand';

const m = (fn: any) => fn as ReturnType<typeof vi.fn>;

interface ConfigStub {
    loadConfig: ReturnType<typeof vi.fn>;
    saveConfig: ReturnType<typeof vi.fn>;
}

function makeStub(): ConfigStub {
    return {
        loadConfig: vi.fn(),
        saveConfig: vi.fn().mockResolvedValue(undefined),
    };
}

describe('UnsetSubCommand', () => {
    let stub: ConfigStub;
    let cmd: UnsetSubCommand;
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
        cmd = new UnsetSubCommand(stub as unknown as any);
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        vi.restoreAllMocks();
    });

    describe('run', () => {
        it('returns early with no-config message when loadConfig returns null', async () => {
            stub.loadConfig.mockResolvedValue(null);
            await cmd.run([], {});
            expect(captured()).toContain('No configuration found to modify');
            expect(stub.saveConfig).not.toHaveBeenCalled();
        });

        it('returns early with no-config message when loadConfig returns an empty object', async () => {
            stub.loadConfig.mockResolvedValue({});
            await cmd.run([], {});
            expect(captured()).toContain('No configuration found to modify');
            expect(stub.saveConfig).not.toHaveBeenCalled();
        });

        it('refuses when explicit key does not exist in config', async () => {
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 't' });
            await cmd.run(['MISSING_KEY'], {});
            expect(captured()).toContain("Configuration key 'MISSING_KEY' does not exist");
            expect(stub.saveConfig).not.toHaveBeenCalled();
        });

        it('removes the key when user confirms (explicit key arg)', async () => {
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 't', GIT_OWNER: 'o' });
            m(inquirer.prompt).mockResolvedValue({ confirmed: true });

            await cmd.run(['GIT_OWNER'], {});

            expect(stub.saveConfig).toHaveBeenCalledTimes(1);
            const written = stub.saveConfig.mock.calls[0][0];
            expect(written).toEqual({ GIT_TOKEN: 't' });
            expect(captured()).toContain("Successfully removed 'GIT_OWNER'");
        });

        it('aborts the deletion when user does NOT confirm', async () => {
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 't' });
            m(inquirer.prompt).mockResolvedValue({ confirmed: false });

            await cmd.run(['GIT_TOKEN'], {});

            expect(stub.saveConfig).not.toHaveBeenCalled();
            expect(captured()).toContain('Operation cancelled');
        });

        it('warns on critical key removal (GIT_TOKEN)', async () => {
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 'tok' });
            m(inquirer.prompt).mockResolvedValue({ confirmed: true });

            await cmd.run(['GIT_TOKEN'], {});
            expect(captured()).toContain('critical configuration key');
            expect(captured()).toContain('Removing this will disable git provider access');
        });

        it('warns on each documented critical key', async () => {
            const criticalWarnings: Record<string, string> = {
                AI_DEFAULT_PROVIDER: 'Removing this will disable AI functionality',
                GIT_TOKEN: 'Removing this will disable git provider access',
                GIT_OWNER: 'Removing this will break repository operations',
                GIT_PROVIDER: 'Removing this will default the git provider to github',
                GIT_NAME: 'Removing this will break Git commit operations',
                GIT_EMAIL: 'Removing this will break Git commit operations',
            };

            for (const [key, warning] of Object.entries(criticalWarnings)) {
                logSpy.mockClear();
                stub.loadConfig.mockResolvedValue({ [key]: 'x' });
                m(inquirer.prompt).mockResolvedValue({ confirmed: false });
                await cmd.run([key], {});
                expect(captured()).toContain(warning);
            }
        });

        it('falls back to interactive prompt when no key argument provided', async () => {
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 't' });
            m(inquirer.prompt)
                .mockResolvedValueOnce({ selectedKey: 'GIT_TOKEN' })
                .mockResolvedValueOnce({ confirmed: true });

            await cmd.run([], {});

            expect(stub.saveConfig).toHaveBeenCalledWith({});
        });

        it('cancels the operation when interactive prompt returns null', async () => {
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 't' });
            m(inquirer.prompt).mockResolvedValue({ selectedKey: null });

            await cmd.run([], {});

            expect(stub.saveConfig).not.toHaveBeenCalled();
            expect(captured()).toContain('Operation cancelled');
        });

        it('shows orphaned-related-keys warning after removing _API_KEY', async () => {
            stub.loadConfig.mockResolvedValue({
                PLUGIN_OPENAI_API_KEY: 'k',
                PLUGIN_OPENAI_DEFAULT_MODEL: 'gpt-4o',
            });
            m(inquirer.prompt).mockResolvedValue({ confirmed: true });

            await cmd.run(['PLUGIN_OPENAI_API_KEY'], {});

            expect(captured()).toContain('Related keys still exist');
            expect(captured()).toContain('PLUGIN_OPENAI_DEFAULT_MODEL');
        });

        it('shows fallback-providers warning after removing AI_DEFAULT_PROVIDER', async () => {
            stub.loadConfig.mockResolvedValue({
                AI_DEFAULT_PROVIDER: 'openai',
                AI_FALLBACK_PROVIDERS: 'anthropic,google',
            });
            m(inquirer.prompt).mockResolvedValue({ confirmed: true });

            await cmd.run(['AI_DEFAULT_PROVIDER'], {});

            expect(captured()).toContain('Consider updating AI_FALLBACK_PROVIDERS');
        });

        it('handles errors thrown during loadConfig', async () => {
            stub.loadConfig.mockRejectedValue(new Error('disk error'));
            await cmd.run([], {});
            expect(captured()).toContain('Failed to unset configuration');
            expect(captured()).toContain('disk error');
        });
    });
});

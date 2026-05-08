import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('fs-extra', () => {
    const ensureDir = vi.fn().mockResolvedValue(undefined);
    const writeJson = vi.fn().mockResolvedValue(undefined);
    const readJson = vi.fn();
    const pathExists = vi.fn();
    return {
        default: { ensureDir, writeJson, readJson, pathExists },
        ensureDir,
        writeJson,
        readJson,
        pathExists,
    };
});

import * as fs from 'fs-extra';
import { ConfigService } from '../config.service';
import type { PartialEverWorksConfig } from '../config.interface';

const m = (fn: any) => fn as ReturnType<typeof vi.fn>;

describe('ConfigService', () => {
    let service: ConfigService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new ConfigService();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getConfigPath / getConfigDir', () => {
        it('returns paths under the user home dir ending with .ever-works', () => {
            expect(service.getConfigDir()).toMatch(/\.ever-works$/);
            expect(service.getConfigPath()).toMatch(/\.ever-works[\\/]config\.json$/);
        });
    });

    describe('configExists', () => {
        it('proxies to fs.pathExists with the config path', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            await expect(service.configExists()).resolves.toBe(true);
            expect(fs.pathExists).toHaveBeenCalledWith(service.getConfigPath());
        });

        it('returns false when fs.pathExists rejects', async () => {
            m(fs.pathExists).mockRejectedValue(new Error('boom'));
            await expect(service.configExists()).resolves.toBe(false);
        });
    });

    describe('loadConfig', () => {
        it('returns null when the config file does not exist', async () => {
            m(fs.pathExists).mockResolvedValue(false);
            await expect(service.loadConfig()).resolves.toBeNull();
            expect(fs.readJson).not.toHaveBeenCalled();
        });

        it('returns the parsed JSON when the config file exists', async () => {
            const cfg = { GIT_TOKEN: 'tok' };
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue(cfg);
            await expect(service.loadConfig()).resolves.toEqual(cfg);
            expect(fs.readJson).toHaveBeenCalledWith(service.getConfigPath());
        });

        it('wraps fs.readJson errors with a Failed-to-load message', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockRejectedValue(new Error('parse error'));
            await expect(service.loadConfig()).rejects.toThrow(
                /Failed to load configuration: parse error/,
            );
        });
    });

    describe('saveConfig', () => {
        it('ensures the config dir exists, then writes JSON with 2-space indent', async () => {
            const order: string[] = [];
            m(fs.ensureDir).mockImplementation(async () => {
                order.push('ensureDir');
            });
            m(fs.writeJson).mockImplementation(async () => {
                order.push('writeJson');
            });

            const cfg: PartialEverWorksConfig = { GIT_TOKEN: 'tok' };
            await service.saveConfig(cfg);

            expect(order).toEqual(['ensureDir', 'writeJson']);
            const writeCall = m(fs.writeJson).mock.calls[0];
            expect(writeCall[0]).toBe(service.getConfigPath());
            expect(writeCall[1]).toEqual({ GIT_TOKEN: 'tok' });
            expect(writeCall[2]).toEqual({ spaces: 2 });
        });

        it('strips undefined / null / empty-string values before writing', async () => {
            await service.saveConfig({
                GIT_TOKEN: 'tok',
                GIT_OWNER: undefined,
                GIT_NAME: null,
                GIT_EMAIL: '',
                GIT_PROVIDER: 'github',
            } as PartialEverWorksConfig);

            const writtenCfg = m(fs.writeJson).mock.calls[0][1];
            expect(writtenCfg).toEqual({ GIT_TOKEN: 'tok', GIT_PROVIDER: 'github' });
            expect(writtenCfg).not.toHaveProperty('GIT_OWNER');
            expect(writtenCfg).not.toHaveProperty('GIT_NAME');
            expect(writtenCfg).not.toHaveProperty('GIT_EMAIL');
        });

        it('wraps ensureDir failures with a Failed-to-create message', async () => {
            m(fs.ensureDir).mockRejectedValue(new Error('eperm'));
            await expect(service.saveConfig({ GIT_TOKEN: 'tok' })).rejects.toThrow(
                /Failed to save configuration: Failed to create config work: eperm/,
            );
        });

        it('wraps writeJson failures with a Failed-to-save message', async () => {
            m(fs.writeJson).mockRejectedValue(new Error('disk full'));
            await expect(service.saveConfig({ GIT_TOKEN: 'tok' })).rejects.toThrow(
                /Failed to save configuration: disk full/,
            );
        });
    });

    describe('mergeConfig', () => {
        it('merges new config onto existing (new wins on conflict)', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({ GIT_TOKEN: 'old', GIT_OWNER: 'me' });

            await service.mergeConfig({ GIT_TOKEN: 'new', GIT_NAME: 'Me' });

            const written = m(fs.writeJson).mock.calls[0][1];
            expect(written).toEqual({
                GIT_TOKEN: 'new',
                GIT_OWNER: 'me',
                GIT_NAME: 'Me',
            });
        });

        it('treats missing existing config as empty object', async () => {
            m(fs.pathExists).mockResolvedValue(false);
            await service.mergeConfig({ GIT_TOKEN: 'new' });
            const written = m(fs.writeJson).mock.calls[0][1];
            expect(written).toEqual({ GIT_TOKEN: 'new' });
        });
    });

    describe('validateConfig', () => {
        const baseValid = {
            GIT_TOKEN: 't',
            GIT_OWNER: 'o',
            GIT_NAME: 'n',
            GIT_EMAIL: 'e@e.com',
            PLUGIN_OPENAI_API_KEY: 'sk-x',
        };

        it('returns isValid:true with no errors when all required fields present and an AI provider configured', () => {
            const result = service.validateConfig(baseValid);
            expect(result.isValid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        it('flags each missing required git field individually', () => {
            const result = service.validateConfig({
                PLUGIN_OPENAI_API_KEY: 'sk-x',
            } as PartialEverWorksConfig);
            expect(result.isValid).toBe(false);
            expect(result.errors).toEqual(
                expect.arrayContaining([
                    'GIT_TOKEN is required',
                    'GIT_OWNER is required',
                    'GIT_NAME is required',
                    'GIT_EMAIL is required',
                ]),
            );
        });

        it('emits a no-AI-provider warning when none of the AI keys are set', () => {
            const result = service.validateConfig({
                GIT_TOKEN: 't',
                GIT_OWNER: 'o',
                GIT_NAME: 'n',
                GIT_EMAIL: 'e@e.com',
            });
            expect(result.warnings).toEqual(
                expect.arrayContaining([
                    'No AI provider plugin configured. Set at least one PLUGIN_*_API_KEY.',
                ]),
            );
        });

        it.each([
            'PLUGIN_OPENROUTER_API_KEY',
            'PLUGIN_OPENAI_API_KEY',
            'PLUGIN_GOOGLE_API_KEY',
            'PLUGIN_ANTHROPIC_API_KEY',
            'PLUGIN_GROQ_API_KEY',
            'PLUGIN_OLLAMA_BASE_URL',
        ])('%s alone satisfies the AI-provider requirement', (key) => {
            const cfg: PartialEverWorksConfig = {
                GIT_TOKEN: 't',
                GIT_OWNER: 'o',
                GIT_NAME: 'n',
                GIT_EMAIL: 'e@e.com',
                [key]: 'value',
            };
            const result = service.validateConfig(cfg);
            expect(result.warnings).not.toEqual(
                expect.arrayContaining([
                    'No AI provider plugin configured. Set at least one PLUGIN_*_API_KEY.',
                ]),
            );
        });

        it('warns when EXTRACT_CONTENT_SERVICE is tavily but PLUGIN_TAVILY_API_KEY is missing', () => {
            const result = service.validateConfig({
                ...baseValid,
                EXTRACT_CONTENT_SERVICE: 'tavily',
            });
            expect(result.warnings).toEqual(
                expect.arrayContaining([
                    'PLUGIN_TAVILY_API_KEY is recommended when using Tavily services',
                ]),
            );
        });

        it('warns when WEB_SEARCH_SERVICE is tavily but PLUGIN_TAVILY_API_KEY is missing', () => {
            const result = service.validateConfig({
                ...baseValid,
                WEB_SEARCH_SERVICE: 'tavily',
            });
            expect(result.warnings).toEqual(
                expect.arrayContaining([
                    'PLUGIN_TAVILY_API_KEY is recommended when using Tavily services',
                ]),
            );
        });

        it('does NOT warn about Tavily when PLUGIN_TAVILY_API_KEY is set', () => {
            const result = service.validateConfig({
                ...baseValid,
                EXTRACT_CONTENT_SERVICE: 'tavily',
                WEB_SEARCH_SERVICE: 'tavily',
                PLUGIN_TAVILY_API_KEY: 'tvly-x',
            });
            expect(result.warnings).not.toEqual(
                expect.arrayContaining([
                    'PLUGIN_TAVILY_API_KEY is recommended when using Tavily services',
                ]),
            );
        });
    });

    describe('loadConfigIntoEnv', () => {
        const ENV_KEYS = [
            'GIT_TOKEN',
            'GIT_OWNER',
            'GIT_PROVIDER',
            'GIT_NAME',
            'GIT_EMAIL',
            'GH_APIKEY',
            'GH_OWNER',
            'PLUGIN_OPENAI_API_KEY',
            'DATABASE_LOGGING',
        ];
        const saved: Record<string, string | undefined> = {};

        beforeEach(() => {
            for (const k of ENV_KEYS) {
                saved[k] = process.env[k];
                delete process.env[k];
            }
        });

        afterEach(() => {
            for (const k of ENV_KEYS) {
                if (saved[k] === undefined) {
                    delete process.env[k];
                } else {
                    process.env[k] = saved[k];
                }
            }
        });

        it('is a no-op when there is no config file', async () => {
            m(fs.pathExists).mockResolvedValue(false);
            await service.loadConfigIntoEnv();
            expect(process.env.GIT_TOKEN).toBeUndefined();
        });

        it('loads each non-null/undefined value into process.env as a String()', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({
                GIT_TOKEN: 'tok',
                GIT_NAME: 'Me',
                DATABASE_LOGGING: true,
                GIT_EMAIL: undefined,
                PLUGIN_OPENAI_API_KEY: null,
            });

            await service.loadConfigIntoEnv();

            expect(process.env.GIT_TOKEN).toBe('tok');
            expect(process.env.GIT_NAME).toBe('Me');
            expect(process.env.DATABASE_LOGGING).toBe('true');
            expect(process.env.GIT_EMAIL).toBeUndefined();
            expect(process.env.PLUGIN_OPENAI_API_KEY).toBeUndefined();
        });

        it('defaults GIT_PROVIDER to "github" when not set', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({ GIT_TOKEN: 'tok' });
            await service.loadConfigIntoEnv();
            expect(process.env.GIT_PROVIDER).toBe('github');
        });

        it('preserves an explicit GIT_PROVIDER from config', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({ GIT_TOKEN: 'tok', GIT_PROVIDER: 'gitlab' });
            await service.loadConfigIntoEnv();
            expect(process.env.GIT_PROVIDER).toBe('gitlab');
        });

        it('mirrors GIT_TOKEN to GH_APIKEY when GH_APIKEY is unset', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({ GIT_TOKEN: 'tok' });
            await service.loadConfigIntoEnv();
            expect(process.env.GH_APIKEY).toBe('tok');
        });

        it('does NOT overwrite GH_APIKEY when it is already set', async () => {
            process.env.GH_APIKEY = 'pre-existing';
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({ GIT_TOKEN: 'tok' });
            await service.loadConfigIntoEnv();
            expect(process.env.GH_APIKEY).toBe('pre-existing');
        });

        it('mirrors GIT_OWNER to GH_OWNER when GH_OWNER is unset', async () => {
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({ GIT_OWNER: 'me' });
            await service.loadConfigIntoEnv();
            expect(process.env.GH_OWNER).toBe('me');
        });

        it('does NOT overwrite GH_OWNER when it is already set', async () => {
            process.env.GH_OWNER = 'pre-existing';
            m(fs.pathExists).mockResolvedValue(true);
            m(fs.readJson).mockResolvedValue({ GIT_OWNER: 'me' });
            await service.loadConfigIntoEnv();
            expect(process.env.GH_OWNER).toBe('pre-existing');
        });
    });
});

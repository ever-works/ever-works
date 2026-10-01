import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ever-works auth login --ever-id` routes to the Ever ID device sign-in (APW-12 S8,
 * FR-39). The device flow itself is covered by `ever-id-device.service.spec.ts`; that
 * nothing changes without the option is pinned by `login.command.browser-flow.spec.ts`.
 */

const mocks = vi.hoisted(() => ({
    runEverIdDeviceLogin: vi.fn(),
    performOAuthFlow: vi.fn(),
    prompt: vi.fn(),
    getProfile: vi.fn(),
    fs: {
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
        chmod: vi.fn(),
        readJson: vi.fn(),
        pathExists: vi.fn(),
        remove: vi.fn(),
    },
}));

vi.mock('../ever-id-device.service', () => ({
    runEverIdDeviceLogin: mocks.runEverIdDeviceLogin,
}));

vi.mock('../oauth.service', () => ({ performOAuthFlow: mocks.performOAuthFlow }));

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }));

vi.mock('../../../services/api.service', () => ({
    getApiService: () => ({ getProfile: mocks.getProfile }),
}));

vi.mock('fs-extra', () => ({ default: mocks.fs, ...mocks.fs }));

const API_URL = 'https://api.example.test';

describe('ever-works auth login --ever-id', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errors: string[];

    async function loadLoginCommand() {
        // A fresh module per test: a commander command keeps parsed option values.
        const { loginCommand } = await import('../login.command');
        return loginCommand;
    }

    beforeEach(() => {
        vi.resetModules();
        for (const mock of [
            mocks.runEverIdDeviceLogin,
            mocks.performOAuthFlow,
            mocks.prompt,
            mocks.getProfile,
            ...Object.values(mocks.fs),
        ]) {
            mock.mockReset();
        }
        mocks.fs.pathExists.mockResolvedValue(false);

        errors = [];
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation((() => undefined as never) as typeof process.exit);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('runs the device sign-in against --api-url instead of the browser hand-off', async () => {
        mocks.runEverIdDeviceLogin.mockResolvedValue(0);
        const loginCommand = await loadLoginCommand();

        await loginCommand.parseAsync(['--ever-id', '--api-url', API_URL], { from: 'user' });

        expect(mocks.runEverIdDeviceLogin).toHaveBeenCalledTimes(1);
        expect(mocks.runEverIdDeviceLogin).toHaveBeenCalledWith({ apiUrl: API_URL });
        expect(mocks.performOAuthFlow).not.toHaveBeenCalled();
        expect(mocks.prompt).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits with code 1 when the device sign-in fails', async () => {
        mocks.runEverIdDeviceLogin.mockResolvedValue(1);
        const loginCommand = await loadLoginCommand();

        await loginCommand.parseAsync(['--ever-id', '--api-url', API_URL], { from: 'user' });

        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('asks before replacing an existing login, like the other sign-in paths', async () => {
        mocks.fs.pathExists.mockResolvedValue(true);
        mocks.fs.readJson.mockResolvedValue({
            token: 'header.eyJleHAiOjk5OTk5OTk5OTl9.signature',
            apiUrl: API_URL,
            email: 'alice@example.com',
        });
        mocks.prompt.mockResolvedValue({ proceed: false });
        const loginCommand = await loadLoginCommand();

        await loginCommand.parseAsync(['--ever-id', '--api-url', API_URL], { from: 'user' });

        expect(mocks.prompt).toHaveBeenCalledTimes(1);
        expect(mocks.runEverIdDeviceLogin).not.toHaveBeenCalled();
    });

    it('cannot be combined with --manual', async () => {
        const loginCommand = await loadLoginCommand();
        loginCommand.exitOverride().configureOutput({
            writeErr: (text) => {
                errors.push(text);
            },
        });

        const parsing = loginCommand.parseAsync(['--ever-id', '--manual'], { from: 'user' });

        await expect(parsing).rejects.toBeInstanceOf(CommanderError);
        await expect(parsing).rejects.toMatchObject({ code: 'commander.conflictingOption' });
        expect(errors.join('')).toContain(
            "option '--ever-id' cannot be used with option '--manual'",
        );
        expect(mocks.runEverIdDeviceLogin).not.toHaveBeenCalled();
        expect(mocks.prompt).not.toHaveBeenCalled();
    });

    it('is listed in the command help', async () => {
        const loginCommand = await loadLoginCommand();

        expect(loginCommand.helpInformation()).toMatch(
            /--ever-id\s+Sign in with Ever ID using a code shown in the terminal/,
        );
    });
});

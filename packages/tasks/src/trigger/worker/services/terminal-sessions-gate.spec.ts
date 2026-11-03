import { describe, expect, it } from 'vitest';
import { TERMINAL_SESSIONS_ENABLED_ENV, terminalSessionsEnabled } from './terminal-sessions-gate';

describe('terminalSessionsEnabled (worker-side gate for the terminal-session task)', () => {
    it('is off when the variable is absent — sessions are opt-in', () => {
        expect(terminalSessionsEnabled({})).toBe(false);
    });

    it('is off for every value other than "true"', () => {
        for (const value of ['', ' ', '1', 'yes', 'on', 'false', 'True1', 'enabled']) {
            expect(terminalSessionsEnabled({ [TERMINAL_SESSIONS_ENABLED_ENV]: value })).toBe(false);
        }
    });

    it('is on for "true", tolerating case and surrounding whitespace', () => {
        for (const value of ['true', 'TRUE', 'True', ' true ', '\ttrue\n']) {
            expect(terminalSessionsEnabled({ [TERMINAL_SESSIONS_ENABLED_ENV]: value })).toBe(true);
        }
    });

    it('reads process.env by default', () => {
        const saved = process.env[TERMINAL_SESSIONS_ENABLED_ENV];
        try {
            delete process.env[TERMINAL_SESSIONS_ENABLED_ENV];
            expect(terminalSessionsEnabled()).toBe(false);
            process.env[TERMINAL_SESSIONS_ENABLED_ENV] = 'true';
            expect(terminalSessionsEnabled()).toBe(true);
        } finally {
            if (saved === undefined) delete process.env[TERMINAL_SESSIONS_ENABLED_ENV];
            else process.env[TERMINAL_SESSIONS_ENABLED_ENV] = saved;
        }
    });
});

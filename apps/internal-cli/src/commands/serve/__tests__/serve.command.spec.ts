import { describe, it, expect } from 'vitest';

// We import after the mocks below in case the module-level imports fail.
// The Option methods (parsePort, parseHost) on ServeCommand do not depend on
// any constructor-injected service — they're pure validators — so we can
// instantiate the class with `null` for the ConfigCheckService arg.

import { ServeCommand } from '../serve.command';

describe('ServeCommand option parsers', () => {
    const cmd = new ServeCommand(null as unknown as any);

    describe('parsePort', () => {
        it('returns the parsed integer for a valid port string', () => {
            expect(cmd.parsePort('3100')).toBe(3100);
            expect(cmd.parsePort('1')).toBe(1);
            expect(cmd.parsePort('65535')).toBe(65535);
        });

        it('throws when the string is not a number', () => {
            expect(() => cmd.parsePort('abc')).toThrow(/Port must be a number between 1 and 65535/);
            expect(() => cmd.parsePort('')).toThrow(/Port must be a number between 1 and 65535/);
        });

        it('throws when the port is below 1', () => {
            expect(() => cmd.parsePort('0')).toThrow(/Port must be a number between 1 and 65535/);
            expect(() => cmd.parsePort('-1')).toThrow(/Port must be a number between 1 and 65535/);
        });

        it('throws when the port is above 65535', () => {
            expect(() => cmd.parsePort('65536')).toThrow(
                /Port must be a number between 1 and 65535/,
            );
            expect(() => cmd.parsePort('99999')).toThrow(
                /Port must be a number between 1 and 65535/,
            );
        });

        it('parseInt strips trailing non-numeric characters (existing behavior)', () => {
            // parseInt('3100abc', 10) → 3100, which is in range → accepted
            expect(cmd.parsePort('3100abc')).toBe(3100);
        });
    });

    describe('parseHost', () => {
        it('returns the trimmed host string', () => {
            expect(cmd.parseHost('localhost')).toBe('localhost');
            expect(cmd.parseHost('  127.0.0.1  ')).toBe('127.0.0.1');
        });

        it('throws when the value is empty or all-whitespace', () => {
            expect(() => cmd.parseHost('')).toThrow(/Host cannot be empty/);
            expect(() => cmd.parseHost('   ')).toThrow(/Host cannot be empty/);
        });
    });
});

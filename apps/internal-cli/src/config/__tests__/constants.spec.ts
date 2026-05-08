import { describe, it, expect } from 'vitest';
import { COMMAND, COMMAND_ALIAS } from '../constants';

describe('config/constants', () => {
    it('COMMAND is the literal "ew"', () => {
        expect(COMMAND).toBe('ew');
    });

    it('COMMAND_ALIAS is the literal "ew" (currently identical)', () => {
        expect(COMMAND_ALIAS).toBe('ew');
    });

    it('COMMAND and COMMAND_ALIAS are stable strings', () => {
        expect(typeof COMMAND).toBe('string');
        expect(typeof COMMAND_ALIAS).toBe('string');
    });
});

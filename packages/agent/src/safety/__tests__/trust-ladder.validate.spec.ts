import { isPromotion, validateRungWrite } from '../trust-ladder';

describe('validateRungWrite', () => {
    it('allows a one-rung promotion on a draftable category', () => {
        expect(
            validateRungWrite({ category: 'message.external', current: 'off', next: 'draft' }),
        ).toBeNull();
        expect(
            validateRungWrite({ category: 'message.external', current: 'draft', next: 'ask' }),
        ).toBeNull();
    });

    it('allows a one-rung promotion that SKIPS Draft where Draft is not offered', () => {
        // FR-8 / FR-32 — for a category with no reviewable artefact the ladder
        // is off → ask → auto, and `off → ask` is one rung, not two.
        expect(
            validateRungWrite({ category: 'read.external', current: 'off', next: 'ask' }),
        ).toBeNull();
    });

    it('refuses a promotion that skips a rung, naming the intermediate one', () => {
        const violation = validateRungWrite({
            category: 'message.external',
            current: 'off',
            next: 'ask',
        });
        expect(violation).toMatch(/One rung at a time/);
        expect(violation).toMatch(/draft/);
    });

    it('refuses Draft for a category that does not offer it', () => {
        const violation = validateRungWrite({
            category: 'read.external',
            current: 'off',
            next: 'draft',
        });
        expect(violation).toMatch(/does not offer the draft rung/);
    });

    it('refuses anything above the ceiling, naming the ceiling', () => {
        const violation = validateRungWrite({
            category: 'message.external',
            current: 'ask',
            next: 'auto',
        });
        expect(violation).toMatch(/may never go above ask/);
        expect(violation).toMatch(/not a setting/);
    });

    it('answers money with its own sentence, not a generic ceiling message', () => {
        // FR-12 is the absence of a mechanism, not a stricter setting, and the
        // two mean different things to the person reading the refusal.
        const violation = validateRungWrite({
            category: 'spend.commitment',
            current: 'off',
            next: 'ask',
        });
        expect(violation).toMatch(/never something an agent does/);
        expect(violation).toMatch(/buy, refund or move money/);
    });

    it('refuses an agent rung above its workspace, naming the workspace rung', () => {
        const violation = validateRungWrite({
            category: 'machine.run',
            current: 'ask',
            next: 'auto',
            workspaceRung: 'ask',
        });
        expect(violation).toMatch(/only narrow/);
        expect(violation).toMatch(/workspace allows ask/);
    });

    it('allows an agent rung at or below its workspace', () => {
        expect(
            validateRungWrite({
                category: 'machine.run',
                current: 'auto',
                next: 'ask',
                workspaceRung: 'auto',
            }),
        ).toBeNull();
    });

    it('allows demotion of any distance, with no confirmation and no dwell', () => {
        // FR-33 — demotion is unrestricted and immediate. An owner who wants
        // to stop something must never be told to do it in three steps.
        expect(
            validateRungWrite({ category: 'read.external', current: 'auto', next: 'off' }),
        ).toBeNull();
        expect(
            validateRungWrite({ category: 'message.external', current: 'ask', next: 'off' }),
        ).toBeNull();
    });

    it('allows writing the rung a category is already on', () => {
        expect(
            validateRungWrite({ category: 'write.internal', current: 'auto', next: 'auto' }),
        ).toBeNull();
    });

    it('checks the ceiling before the one-rung rule', () => {
        // `machine.admin` is capped at ask; asking for auto from ask is both a
        // ceiling violation and a legal one-rung step, and the ceiling is the
        // answer that helps.
        const violation = validateRungWrite({
            category: 'machine.admin',
            current: 'ask',
            next: 'auto',
        });
        expect(violation).toMatch(/may never go above ask/);
    });

    it('returns the FIRST violation only, like validateGuardrails next door', () => {
        const violation = validateRungWrite({
            category: 'read.external',
            current: 'off',
            next: 'draft',
        });
        expect(typeof violation).toBe('string');
        expect(violation?.split('\n')).toHaveLength(1);
    });
});

describe('isPromotion', () => {
    it('is true only when the rung grants more', () => {
        expect(isPromotion('off', 'draft')).toBe(true);
        expect(isPromotion('ask', 'auto')).toBe(true);
        expect(isPromotion('auto', 'ask')).toBe(false);
        expect(isPromotion('ask', 'ask')).toBe(false);
    });
});

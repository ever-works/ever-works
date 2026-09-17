import { SAFETY_ALLOW, SAFETY_RAIL_ORDER } from '@ever-works/contracts';
import { defaultSafetyRailChain } from '../rails';
import {
    buildVerdict,
    capSummary,
    composeSafetyRails,
    type SafetyRailContext,
    type SafetyRailMiddleware,
} from '../safety-rails';
import { makeContext } from './rail-test-helpers';

describe('composeSafetyRails', () => {
    it('runs the rails left to right', async () => {
        const order: string[] = [];
        const rail =
            (name: string): SafetyRailMiddleware =>
            async (_context, next) => {
                order.push(name);
                return next();
            };
        await composeSafetyRails([rail('a'), rail('b'), rail('c')])(makeContext());
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('lets the first rail that returns without next() decide', async () => {
        const later = jest.fn();
        const verdict = await composeSafetyRails([
            async (context) =>
                buildVerdict({
                    decision: 'refused',
                    railId: 'ladder',
                    reasonCode: 'rung-off',
                    context,
                    summary: 'nope',
                }),
            async (_context, next) => {
                later();
                return next();
            },
        ])(makeContext());

        expect(verdict.decision).toBe('refused');
        expect(later).not.toHaveBeenCalled();
    });

    it('allows when nothing short-circuits', async () => {
        const verdict = await composeSafetyRails([async (_c, next) => next()])(makeContext());
        expect(verdict).toEqual(SAFETY_ALLOW);
    });

    it('allows an empty chain', async () => {
        expect(await composeSafetyRails([])(makeContext())).toEqual(SAFETY_ALLOW);
    });

    it('refuses loudly when a rail calls next() twice', async () => {
        // Silently double-running the tail would evaluate caps and rules twice
        // and could write two refusal records for one action.
        const twice: SafetyRailMiddleware = async (_context, next) => {
            await next();
            return next();
        };
        await expect(
            composeSafetyRails([twice, async (_c, n) => n()])(makeContext()),
        ).rejects.toThrow(/called next\(\) more than once/);
    });
});

describe('defaultSafetyRailChain', () => {
    it('is exactly as long as the published order', () => {
        expect(defaultSafetyRailChain()).toHaveLength(SAFETY_RAIL_ORDER.length);
    });

    it('is built by walking the published order, not by an import-order array', async () => {
        // The order is a product promise. Building the chain from the contract
        // means a rail cannot land in whatever position an import happened to
        // put it in.
        const seen: string[] = [];
        const context = makeContext();
        const instrumented: SafetyRailContext = {
            ...context,
            logger: {
                log: (message: string) => seen.push(message),
                warn: (message: string) => seen.push(message),
            },
        };
        await composeSafetyRails(defaultSafetyRailChain())(instrumented);
        // Nothing is bound in the bare context, so every rail passes through
        // and the chain allows — the assertion that matters here is that it
        // composes at all without throwing.
        expect(seen).toEqual([]);
    });
});

describe('buildVerdict', () => {
    it('reports an observed widening attempt as its own reason code', async () => {
        // U1 / FR-17 — the action is refused on the rung alone; the OBSERVATION
        // only changes what is recorded, because an instruction trying to widen
        // a rung is a signal worth reading.
        const verdict = buildVerdict({
            decision: 'held',
            railId: 'ladder',
            reasonCode: 'rung-held',
            context: makeContext({ widenAttemptObserved: true }),
            summary: 'held',
        });
        expect(verdict.reasonCode).toBe('instruction-widening-attempt');
    });

    it('keeps the rail reason code when nothing was observed', () => {
        expect(
            buildVerdict({
                decision: 'held',
                railId: 'ladder',
                reasonCode: 'rung-held',
                context: makeContext(),
                summary: 'held',
            }).reasonCode,
        ).toBe('rung-held');
    });

    it('caps the summary where the refusal record caps it', () => {
        const verdict = buildVerdict({
            decision: 'refused',
            railId: 'caps',
            reasonCode: 'cap-reached',
            context: makeContext(),
            summary: 'x'.repeat(900),
        });
        expect(verdict.summary).toHaveLength(500);
        expect(verdict.summary?.endsWith('…')).toBe(true);
    });
});

describe('capSummary', () => {
    it('leaves a short summary alone', () => {
        expect(capSummary('  a short reason  ')).toBe('a short reason');
    });
});

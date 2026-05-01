import {
    createGenerationCancelledError,
    isGenerationCancelledError,
    throwIfGenerationCancelled,
} from '../generation-cancellation.utils';
import { GENERATION_CANCELLED } from '../../constants';

describe('generation cancellation utils', () => {
    it('creates a standard abort error', () => {
        const error = createGenerationCancelledError();

        expect(error.name).toBe('AbortError');
        expect(error.message).toBe(GENERATION_CANCELLED);
        expect(isGenerationCancelledError(error)).toBe(true);
    });

    it('throws the abort signal reason when it is already an error', () => {
        const controller = new AbortController();
        const reason = new Error('custom cancellation');

        controller.abort(reason);

        expect(() => throwIfGenerationCancelled(controller.signal)).toThrow(reason);
    });

    it('throws a standard abort error when the signal has no error reason', () => {
        const controller = new AbortController();

        controller.abort();

        expect(() => throwIfGenerationCancelled(controller.signal)).toThrow(GENERATION_CANCELLED);
    });
});

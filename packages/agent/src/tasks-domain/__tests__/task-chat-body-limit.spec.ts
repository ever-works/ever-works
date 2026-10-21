import { BadRequestException } from '@nestjs/common';
import { TaskChatService } from '../task-chat.service';

/**
 * Review 2026-10-17 F40: the comment cap (16384) is counted in characters (code
 * points), as the integration DTO (`@Length`) and the contract (`maxLength`) count
 * them. Counted in UTF-16 units, a body of emoji within the contract was refused.
 */
describe('TaskChatService body cap', () => {
    const service = new TaskChatService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
    );
    const assertBody = (body: string) =>
        (service as unknown as { assertBody(body: string): void }).assertBody(body);

    it('accepts 16384 characters, emoji included, and refuses one more', () => {
        expect(() => assertBody('😀'.repeat(16_384))).not.toThrow();
        expect(() => assertBody('😀'.repeat(16_385))).toThrow(BadRequestException);
        expect(() => assertBody('a'.repeat(16_384))).not.toThrow();
        expect(() => assertBody('a'.repeat(16_385))).toThrow(BadRequestException);
    });
});

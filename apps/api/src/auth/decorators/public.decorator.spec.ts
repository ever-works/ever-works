import 'reflect-metadata';
import { Public, IS_PUBLIC_KEY } from './public.decorator';

describe('@Public() decorator', () => {
    it('IS_PUBLIC_KEY is the literal string "isPublic"', () => {
        // Pinned literally because AuthSessionGuard reads this metadata key via
        // Reflector.getAllAndOverride(IS_PUBLIC_KEY, ...). A silent rename here
        // would make every @Public() route silently fall through to auth checks.
        expect(IS_PUBLIC_KEY).toBe('isPublic');
    });

    it('attaches metadata { isPublic: true } to the decorated handler', () => {
        class Controller {
            @Public()
            handler() {
                return 'ok';
            }
        }

        const meta = Reflect.getMetadata(IS_PUBLIC_KEY, Controller.prototype.handler);
        expect(meta).toBe(true);
    });

    it('attaches metadata to the decorated class as well (class-level @Public)', () => {
        @Public()
        class Public_Controller {}

        const meta = Reflect.getMetadata(IS_PUBLIC_KEY, Public_Controller);
        expect(meta).toBe(true);
    });

    it('does not pollute non-decorated handlers (negative path for guard reflection)', () => {
        class Controller {
            @Public()
            publicHandler() {
                return 'ok';
            }
            protectedHandler() {
                return 'ok';
            }
        }

        expect(Reflect.getMetadata(IS_PUBLIC_KEY, Controller.prototype.protectedHandler)).toBeUndefined();
    });

    it('Public is a zero-arg factory returning a method/class decorator', () => {
        const decorator = Public();
        expect(typeof decorator).toBe('function');
    });
});

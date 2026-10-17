/**
 * jest-dom matcher types for vitest 5.
 *
 * `vitest.setup.ts` registers the matchers at runtime (`expect.extend(matchers)`),
 * but their TYPES came from jest-dom's `declare module 'vitest' { interface
 * Assertion<T> … }`. vitest 5's `Assertion<R, T>` takes two type parameters, so
 * that one-parameter augmentation no longer merges and every
 * `toBeInTheDocument` / `toHaveTextContent` / … in the specs fails type-check
 * (which `next build` runs). This augments vitest's documented extension point,
 * `Matchers<R, T>`, which `Assertion` extends. Remove it once jest-dom ships
 * vitest 5 typings.
 */
import 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
    interface Matchers<
        R extends void | Promise<void> = void | Promise<void>,
        T = unknown,
    > extends TestingLibraryMatchers<unknown, R> {}
}

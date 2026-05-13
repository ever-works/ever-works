/**
 * Jest replacement for the ESM-only `p-map` package.
 *
 * `p-map` ships as ESM and ts-jest can't load it under the agent's
 * CommonJS test runner. The runtime behaviour we care about for tests
 * is "iterate the inputs through the mapper and return their results"
 * — concurrency limits don't affect correctness in unit tests, so a
 * straight Promise.all is sufficient.
 *
 * Wired in via `moduleNameMapper` in jest.config.js so every spec
 * automatically picks up this stub regardless of its import chain.
 */
export default async function pMap<T, R>(
    input: Iterable<T>,
    mapper: (value: T, index: number) => Promise<R> | R,
): Promise<R[]> {
    const items = Array.from(input);
    return Promise.all(items.map((value, index) => mapper(value, index)));
}

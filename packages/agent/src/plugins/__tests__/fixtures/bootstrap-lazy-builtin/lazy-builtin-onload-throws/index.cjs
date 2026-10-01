'use strict';

/**
 * Test fixture for `plugin-bootstrap.lazy-builtin.spec.ts`: a disk-discovered
 * `builtIn` plugin whose `onLoad` throws, the shape of a plugin whose required
 * configuration is missing. Plain CommonJS so it needs no build.
 *
 * `onLoad` counts its calls in `globalThis.__lazyBuiltinOnload[id]` BEFORE it
 * throws, so every attempt is counted.
 */
class LazyBuiltinOnloadThrowsPlugin {
    constructor() {
        this.id = 'lazy-builtin-onload-throws';
        this.name = 'Lazy Built-in onLoad Throws';
        this.version = '1.0.0';
        this.category = 'utility';
        this.capabilities = [];
    }

    async onLoad() {
        const counts = (globalThis.__lazyBuiltinOnload = globalThis.__lazyBuiltinOnload || {});
        counts[this.id] = (counts[this.id] || 0) + 1;
        throw new Error('fixture: apiKey missing');
    }

    async onUnload() {}
}

module.exports = LazyBuiltinOnloadThrowsPlugin;

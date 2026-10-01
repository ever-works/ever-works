'use strict';

/**
 * Test fixture for `plugin-bootstrap.lazy-builtin.spec.ts`: a plugin marked
 * `builtIn: true` in its package.json that the REAL loader discovers on disk
 * and registers as a lazy proxy. Plain CommonJS so it needs no build.
 *
 * - `onLoad` counts its calls in `globalThis.__lazyBuiltinOnload[id]`.
 * - `settingsSchema` exists only on the class (as for every real plugin):
 *   a required secret bound to `LAZY_BUILTIN_FIXTURE_API_KEY`.
 * - `getManifest()` adds `defaultForCapabilities`, which package.json does
 *   not carry — the loader folds it into the registry entry only once the
 *   plugin materialises.
 */
class LazyBuiltinPlugin {
    constructor() {
        this.id = 'lazy-builtin';
        this.name = 'Lazy Built-in';
        this.version = '1.0.0';
        this.category = 'utility';
        this.capabilities = ['lazy-fixture'];
        this.configurationMode = 'hybrid';
        this.settingsSchema = {
            type: 'object',
            properties: {
                apiKey: {
                    type: 'string',
                    'x-secret': true,
                    'x-envVar': 'LAZY_BUILTIN_FIXTURE_API_KEY',
                },
            },
            required: ['apiKey'],
        };
    }

    getManifest() {
        return {
            id: this.id,
            name: this.name,
            version: this.version,
            category: this.category,
            capabilities: this.capabilities,
            description: 'runtime manifest',
            defaultForCapabilities: ['lazy-fixture'],
        };
    }

    async onLoad() {
        const counts = (globalThis.__lazyBuiltinOnload = globalThis.__lazyBuiltinOnload || {});
        counts[this.id] = (counts[this.id] || 0) + 1;
    }

    async onUnload() {}
}

module.exports = LazyBuiltinPlugin;

'use strict';

/**
 * Test fixture for `trigger-run-plugin-operation.module.spec.ts`: a plugin the
 * REAL loader discovers from `pluginPaths`, registers as a lazy proxy (not
 * `builtIn`) and materialises on first use. Plain CommonJS so it needs no build.
 */
class FixtureEchoPlugin {
    constructor() {
        this.id = 'fixture-echo';
        this.name = 'Fixture Echo';
        this.version = '1.0.0';
        this.category = 'utility';
        this.capabilities = [];
    }

    async onLoad() {}

    async onUnload() {}

    getManifest() {
        return {
            id: this.id,
            name: this.name,
            version: this.version,
            category: this.category,
            capabilities: [],
        };
    }

    /** The operation the spec calls. */
    async echo(args) {
        return { echoed: args === undefined ? null : args };
    }

    /** An operation that throws. */
    async explode() {
        throw new Error('fixture exploded');
    }

    /** A private helper: never callable as an operation. */
    _secret() {
        return 'private';
    }
}

module.exports = FixtureEchoPlugin;

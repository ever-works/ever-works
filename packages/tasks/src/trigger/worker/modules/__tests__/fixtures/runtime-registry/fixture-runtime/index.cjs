'use strict';

/**
 * Test fixture for `trigger-run-plugin-operation.module.spec.ts`: the package a
 * stub registry serves. It is NOT under the worker's `pluginPaths`, so the only
 * way it reaches the worker is T27's runtime install — the stub `pacote.extract`
 * copies this directory into the worker's store, and the loader registers it
 * from there. Plain CommonJS so it needs no build.
 *
 * `echo` answers where the module was loaded from, so the spec can prove the
 * copy in the store — not this directory — is what ran.
 */
class FixtureRuntimePlugin {
    constructor() {
        this.id = 'fixture-runtime';
        this.name = 'Fixture Runtime';
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

    /** The one declared operation. */
    async echo(args) {
        return { echoed: args === undefined ? null : args, loadedFrom: __dirname };
    }
}

module.exports = FixtureRuntimePlugin;

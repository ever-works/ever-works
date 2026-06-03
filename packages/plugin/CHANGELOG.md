# @ever-works/plugin

## 1.1.0

### Minor changes

- **EW-693** — Dynamic plugin distribution. Added two additive,
  forward-compatible fields to `PluginManifest`:
  - `distribution?: 'core' | 'registry'` — declares whether the plugin
    is bundled into the platform image (`core`) or published to a
    registry and installed at runtime (`registry`). When omitted, the
    platform derives a default via `systemPlugin === true ⇒ 'core'`,
    else `'registry'`. Use the new `resolvePluginDistribution(manifest)`
    helper to apply this rule consistently.
  - `executionProfile?: 'sync' | 'long-running'` — declares the default
    routing for capability calls (in-process vs job runtime).

  Both fields are validated by
  `PluginManifestValidatorService`; omitting them keeps older manifests
  valid. New helpers exported: `resolvePluginDistribution`,
  `isPluginDistribution`, `isPluginExecutionProfile`.

  See `docs/specs/features/dynamic-plugin-distribution/spec.md` for the
  full feature spec.

## 1.0.0

- Initial release.

/**
 * APW-07 (App env & dependencies) — the Environment service's public surface.
 *
 * T24/T25's routes, APW-05's Build value materialisation, APW-06's Deploy
 * preflight and T15's listener consume this barrel, not the file paths (plan
 * §5:822-826): `AppEnvService.list/missingRequired/buildRedactor/ensureGenerated`,
 * `AppEnvService.apply/rotate` for the write routes, and `AppEnvCrypto` for the
 * epic's one envelope.
 *
 * The six provisional tokens are exported on purpose — their owners bind them
 * (`{ provide: APP_ENV_SPEC_SOURCE, useExisting: … }` and the same for the
 * parser, the activity writer, the two recorded fingerprint maps and the
 * resolver's), so a consumer takes the token from the owner of the seam rather
 * than declaring a second `Symbol` of the same name.
 */

export {
    APP_ENV_ACTIVITY,
    APP_ENV_ACTIVITY_ACTIONS,
    APP_ENV_ACTOR_NAMES,
    APP_ENV_BUILD_FINGERPRINTS,
    APP_ENV_DEPLOY_FINGERPRINTS,
    APP_ENV_RESOLVER_FINGERPRINTS,
    APP_ENV_SPEC_SOURCE,
    APP_ENV_WARNING_CODES,
    AppEnvRefusalError,
    AppEnvService,
    isAppEnvRefusalError,
    orderAppEnvEntries,
    resolvedGenerateSpec,
    resolvedGeneratorFingerprint,
    summarizeAppEnvEntries,
    type AppEnvActivity,
    type AppEnvActivityAction,
    type AppEnvActivityEvent,
    type AppEnvActor,
    type AppEnvActorNames,
    type AppEnvApplyAction,
    type AppEnvApplyInput,
    type AppEnvApplyReason,
    type AppEnvApplyResult,
    type AppEnvApplyResultItem,
    type AppEnvApplyWarning,
    type AppEnvDeployedFingerprints,
    type AppEnvEnsureGeneratedResult,
    type AppEnvEnsureGeneratedSkipCode,
    type AppEnvGeneratedEntry,
    type AppEnvMissingRequirement,
    type AppEnvRecordedFingerprints,
    type AppEnvRefusalCode,
    type AppEnvResolvedFingerprints,
    type AppEnvRotateResult,
    type AppEnvSetItem,
    type AppEnvSpecSnapshot,
    type AppEnvSpecSource,
    type AppEnvSummary,
    type AppEnvViewer,
    type AppEnvWarningCode,
} from './app-env.service';

export { AppEnvModule } from './app-env.module';
// The composition root that binds `APP_RUNTIME_ENV_SOURCE` and
// `APP_ENV_DEPLOY_READINESS` — see its own docstring for why the two swaps
// cannot both live in `AppEnvModule`.
export { AppRuntimeEnvModule } from './app-runtime-env.module';

// APW-07 T14 — the resolver and APW-06's runtime source (plan §2.2, §4.6).
//
// `AppEnvResolver` is what APW-05's `app-build-prepare` calls
// (`resolveForBuild`, plan §5:825) and what T13's `APP_ENV_RESOLVER_FINGERPRINTS`
// swap binds (`read`); `AppEnvRuntimeSource` is the `APP_RUNTIME_ENV_SOURCE`
// implementation APW-06 consumes, and `APP_ENV_DEPLOY_READINESS` the token its
// binder aliases to `AppDependenciesService` (`useExisting`, so the one call
// really is `ensureReadyForDeploy` — GAP-05).
export {
    APP_ENV_BUILD_SERVICE_NAMES,
    APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_DEFAULT,
    APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_ENV,
    APP_ENV_BUILD_SERVICE_POSTGRES_DEFAULTS,
    APP_ENV_BUILD_SERVICE_POSTGRES_ENV,
    APP_ENV_ENSURE_GENERATED,
    APP_ENV_EXTERNAL_PROVIDER_IDS,
    APP_ENV_RESOLUTION_WARNING_CODES,
    APP_ENV_SMTP_RELAY_PROVIDER_ID,
    AppEnvResolver,
    appEnvPhaseCarries,
    appEnvSecretFingerprint,
    appEnvValueFingerprint,
    buildServiceOutputs,
    runnerDependencyLiteral,
    valuesToRecord,
    type AppEnvDeployReadiness,
    type AppEnvDependencyFact,
    type AppEnvEgressDestination,
    type AppEnvEphemeralClusterResolution,
    type AppEnvEphemeralResolutionContext,
    type AppEnvGeneratorPass,
    type AppEnvMissingValue,
    type AppEnvResolutionContext,
    type AppEnvResolutionResult,
    type AppEnvResolutionWarning,
    type AppEnvResolutionWarningCode,
    type AppEnvRunnerRecipeResolution,
    type AppEnvRuntimeRecipeEntry,
} from './app-env.resolver';

export {
    APP_ENV_DEPLOY_READINESS,
    AppEnvRuntimeSource,
    notReadyKinds,
    type AppEnvDeployReadinessSource,
    type AppEnvRuntimeEphemeralResolveResult,
    type AppEnvRuntimeResolveResult,
    type AppRuntimeEphemeralEnvContext,
} from './app-env-runtime.source';

// APW-07 T15 — the `app.spec.applied` listener (plan §2.1:84-92, §7:866-867).
//
// The class is exported because a module owner REGISTERS it (`providers`), and
// Nest only scans a provided class's prototypes for `@OnEvent` metadata — an
// unprovided listener is never subscribed. It is deliberately absent from
// `app-env.module.ts`, whose own comment fixes what that module binds; the
// registration site is named in the file docstring and routed in T15's report.
//
// `APP_ENV_SPEC_APPLIED_EVENT` / `AppEnvListenerSpecAppliedEvent` are exported
// for the same reason the six provisional tokens above are: they are this tree's
// one stand-in for APW-03's not-yet-landed `AppSpecAppliedEvent`, and a second
// literal of the same event name is exactly the duplicate-seam defect the epic
// has had to repair twice (T17's two dispatcher Symbols, T12/T13's parser).
export {
    APP_ENV_SPEC_APPLIED_EVENT,
    AppEnvListener,
    type AppEnvListenerOutcome,
    type AppEnvListenerSkipReason,
    type AppEnvListenerSpecAppliedEvent,
} from './app-env.listener';

// APW-07 T12 — the `.env` grammar, re-exported so a consumer of
// `@ever-works/agent/app-env` reaches the parser T13's `apply({ import })`
// consumes without a second entry point.
export * from './dotenv-parser.js';

export {
    APP_ENV_ENVELOPE_PREFIX,
    AppEnvCrypto,
    AppEnvEncryptionUnavailableError,
    AppEnvEnvelopeError,
    hasAppEnvEnvelope,
    isAppEnvEncryptionUnavailableError,
    isAppEnvEnvelopeError,
} from './app-env-crypto';

export {
    APP_ENV_GENERATOR_DEFAULT_ALPHABET,
    APP_ENV_GENERATOR_DEFAULT_BYTES,
    APP_ENV_GENERATOR_DEFAULT_KEYPAIR_TYPE,
    APP_ENV_GENERATOR_DEFAULT_LENGTH,
    AppEnvGeneratorError,
    generateAppEnvValue,
    generateBase64,
    generateChars,
    generateHex,
    generateKeypair,
    generateUuid,
    isAppEnvGeneratorError,
    type AppEnvGeneratedValue,
    type AppEnvKeypair,
} from './generators';

export {
    AppEnvPatternError,
    appEnvPatternCacheSize,
    clearAppEnvPatternCache,
    compileAppEnvPattern,
    isAppEnvPatternError,
    validateAppEnvValue,
    type AppEnvCompiledPattern,
    type AppEnvPatternEngine,
    type AppEnvValidationOptions,
    type AppEnvValidationRefusal,
    type AppEnvValidationResult,
    type AppEnvValueRules,
} from './validation';

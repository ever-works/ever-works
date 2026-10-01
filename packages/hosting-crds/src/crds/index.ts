/**
 * The `hosting.ever.works` CRD schemas (APW-10 plan §3.1–3.2) and the rules that guard them.
 *
 * `crdManifestFiles()` is the one source of the committed `deploy/crds/*.yaml`; the drift test in
 * `__tests__/crds.spec.ts` compares the two byte-for-byte, so a schema change and the manifests it
 * generates are always one commit.
 */
export { ABUSE_SIGNAL_CRD, ABUSE_SIGNAL_CRD_DEFINITION } from './abusesignal.js';
export { APP_BUILD_CRD, APP_BUILD_CRD_DEFINITION } from './appbuild.js';
export type {
	CrdDefinition,
	CustomResourceDefinitionManifest,
	CustomResourceDefinitionSpec,
	CustomResourceDefinitionVersion
} from './crd.js';
export { CRD_API_VERSION, CRD_KIND, customResourceDefinition, rootSchema } from './crd.js';
export {
	base64EncodedLength,
	DIGEST_PINNED_IMAGE_PATTERN,
	TENANT_NAMESPACE_PATTERN,
	UUID_PATTERN
} from './json-schema.js';
export type { JsonSchema, JsonSchemaType } from './json-schema.js';
export {
	CRD_DIRECTORY,
	CRD_MANIFESTS,
	crdFileName,
	crdManifestFiles,
	manifestHeader,
	parseCrdManifest,
	serializeCrdManifest
} from './manifests.js';
export type { CrdManifestFile } from './manifests.js';
export { exceedsWorkObjectLimit, WORK_OBJECT_LIMIT_BYTES, workObjectBytes } from './object-size.js';
export { SELF_CHECK_CRD, SELF_CHECK_CRD_DEFINITION } from './selfcheck.js';
export { USAGE_REPORT_CRD, USAGE_REPORT_CRD_DEFINITION } from './usagereport.js';
export { WORK_CRD, WORK_CRD_DEFINITION } from './work.js';

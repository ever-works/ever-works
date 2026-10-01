/**
 * T5 — `app-security.ts` (plan §4.4, spec FR-12/FR-13, ACC-06-07/ACC-06-08).
 *
 * One `it` per cell of the plan §4.4 table. The table has one row per field and two columns
 * (`your-cluster` | `ever-works-apps`); each cell below names its row in the `it` title so a
 * reviewer can walk the table without reading the implementation.
 *
 * Pure functions only — no clock, no I/O.
 */
import { describe, expect, it } from 'vitest';

import {
	APP_FS_GROUP,
	APP_PRIVILEGED_PORT_THRESHOLD,
	APP_RUNNER_RUN_AS_USER,
	APP_TMP_VOLUME_PATH,
	APP_TMP_VOLUME_SIZE_LIMIT,
	appSecurityRefusals,
	containerSecurityContext,
	namespacePodSecurityLabels,
	podSecurityContext,
	podSecurityPolicyForTarget,
	tmpVolume,
	tmpVolumeMount,
	type AppSecurityComponent,
	type AppSecurityInput,
	type AppSecurityTarget
} from '../app-security';

const component = (overrides: Partial<AppSecurityComponent> = {}): AppSecurityComponent => ({
	name: 'web',
	role: 'web',
	port: 3000,
	...overrides
});

const inputFor = (target: AppSecurityTarget, allowRoot = false, runAsUser?: number | null): AppSecurityInput => ({
	ref: { target },
	policy: { allowRoot },
	...(runAsUser === undefined ? {} : { runAsUser })
});

const YOURS = 'your-cluster' as const;
const MANAGED = 'ever-works-apps' as const;

describe('the render-input type contract (T6 integration, APW06-G27)', () => {
	/**
	 * `AppSecurityTarget` is an ALIAS of the plugin contract's `AppDeployTarget`, not a local
	 * two-value union. It used to be `'your-cluster' | 'ever-works-apps'`, which made
	 * `AppRenderInput` **unassignable** to `AppSecurityInput` because `AppDeployTarget` really has
	 * three values — `none` is a real deploy target (CONTRACTS R-12, restated by R-27):
	 *
	 *     TS2322: Type '"none"' is not assignable to type 'AppSecurityTarget'.
	 *
	 * T6 renders components through this module, so that incompatibility would have surfaced as a
	 * compile error in the renderer rather than here. These assertions are the guard: the first
	 * pins that `none` IS accepted, the second that both previously-supported values still work —
	 * i.e. the fix widened the type rather than changing it.
	 */
	it('accepts every AppDeployTarget value, including `none`', () => {
		const targets: AppSecurityTarget[] = ['none', 'your-cluster', 'ever-works-apps'];
		expect(targets).toHaveLength(3);
		for (const target of targets) {
			// The §4.4 table only branches on the two deployed targets, but `none` must still be
			// answerable rather than throwing: T6 may validate a render before a target exists.
			expect(() => podSecurityPolicyForTarget(target)).not.toThrow();
		}
	});

	it('keeps the two previously-supported targets working unchanged', () => {
		expect(podSecurityPolicyForTarget('your-cluster')).toBe('baseline');
		expect(podSecurityPolicyForTarget('ever-works-apps')).toBe('restricted');
	});
});

describe('podSecurityContext — plan §4.4', () => {
	// Row: pod `runAsNonRoot` | `true`; `false` when `allowRoot` | `true` always
	it('§4.4 pod runAsNonRoot — true on your-cluster', () => {
		expect(podSecurityContext(inputFor(YOURS), component()).runAsNonRoot).toBe(true);
	});

	it('§4.4 pod runAsNonRoot — false on your-cluster when the App Work allows root', () => {
		expect(podSecurityContext(inputFor(YOURS, true), component()).runAsNonRoot).toBe(false);
	});

	it('§4.4 pod runAsNonRoot — true on ever-works-apps even when the App Work allows root', () => {
		expect(podSecurityContext(inputFor(MANAGED, true), component()).runAsNonRoot).toBe(true);
		expect(podSecurityContext(inputFor(MANAGED, false), component()).runAsNonRoot).toBe(true);
	});

	// Row: pod `seccompProfile` | `RuntimeDefault` | `RuntimeDefault`
	it('§4.4 pod seccompProfile — RuntimeDefault on your-cluster', () => {
		expect(podSecurityContext(inputFor(YOURS), component()).seccompProfile).toEqual({
			type: 'RuntimeDefault'
		});
	});

	it('§4.4 pod seccompProfile — RuntimeDefault on ever-works-apps', () => {
		expect(podSecurityContext(inputFor(MANAGED), component()).seccompProfile).toEqual({
			type: 'RuntimeDefault'
		});
	});

	// Row: pod `fsGroup` / `fsGroupChangePolicy` | `10001` / `OnRootMismatch` when volumes | same
	it('§4.4 pod fsGroup — 10001 with OnRootMismatch when the component declares volumes (your-cluster)', () => {
		const context = podSecurityContext(
			inputFor(YOURS),
			component({ volumes: [{ name: 'uploads', path: '/data', size: '1Gi', backup: true }] })
		);

		expect(APP_FS_GROUP).toBe(10001);
		expect(context.fsGroup).toBe(10001);
		expect(context.fsGroupChangePolicy).toBe('OnRootMismatch');
	});

	it('§4.4 pod fsGroup — 10001 with OnRootMismatch when the component declares volumes (ever-works-apps)', () => {
		const context = podSecurityContext(
			inputFor(MANAGED),
			component({ volumes: [{ name: 'uploads', path: '/data', size: '1Gi', backup: true }] })
		);

		expect(context.fsGroup).toBe(10001);
		expect(context.fsGroupChangePolicy).toBe('OnRootMismatch');
	});

	it('§4.4 pod fsGroup — absent when the component declares no volumes (complement of the cell)', () => {
		const noVolumes = podSecurityContext(inputFor(YOURS), component());

		expect(noVolumes).not.toHaveProperty('fsGroup');
		expect(noVolumes).not.toHaveProperty('fsGroupChangePolicy');
		expect(podSecurityContext(inputFor(YOURS), component({ volumes: [] }))).not.toHaveProperty('fsGroup');
	});
});

describe('containerSecurityContext — plan §4.4', () => {
	// Row: container `allowPrivilegeEscalation` | `false` | `false`
	it('§4.4 container allowPrivilegeEscalation — false on your-cluster', () => {
		expect(containerSecurityContext(inputFor(YOURS), component()).allowPrivilegeEscalation).toBe(false);
	});

	it('§4.4 container allowPrivilegeEscalation — false on ever-works-apps', () => {
		expect(containerSecurityContext(inputFor(MANAGED), component()).allowPrivilegeEscalation).toBe(false);
	});

	// Row: container `capabilities` | `drop: [ALL]`; `add: [NET_BIND_SERVICE]` only when `allowRoot`
	// and port < 1024 | `drop: [ALL]`; port < 1024 refused (`privileged_port`)
	it('§4.4 container capabilities — drop [ALL] on your-cluster', () => {
		expect(containerSecurityContext(inputFor(YOURS), component()).capabilities).toEqual({ drop: ['ALL'] });
	});

	it('§4.4 container capabilities — add NET_BIND_SERVICE only when allowRoot and the port is below 1024', () => {
		expect(APP_PRIVILEGED_PORT_THRESHOLD).toBe(1024);

		expect(containerSecurityContext(inputFor(YOURS, true), component({ port: 80 })).capabilities).toEqual({
			drop: ['ALL'],
			add: ['NET_BIND_SERVICE']
		});
		expect(containerSecurityContext(inputFor(YOURS, true), component({ port: 1024 })).capabilities).toEqual({
			drop: ['ALL']
		});
		expect(containerSecurityContext(inputFor(YOURS, true), component({ port: 8080 })).capabilities).toEqual({
			drop: ['ALL']
		});
		expect(containerSecurityContext(inputFor(YOURS, false), component({ port: 80 })).capabilities).toEqual({
			drop: ['ALL']
		});
		expect(
			containerSecurityContext(inputFor(YOURS, true), component({ role: 'worker', port: undefined })).capabilities
		).toEqual({ drop: ['ALL'] });
	});

	it('§4.4 container capabilities — drop [ALL] and never an added capability on ever-works-apps', () => {
		expect(containerSecurityContext(inputFor(MANAGED), component()).capabilities).toEqual({ drop: ['ALL'] });
		expect(containerSecurityContext(inputFor(MANAGED, true), component({ port: 80 })).capabilities).toEqual({
			drop: ['ALL']
		});
	});

	it('§4.4 container capabilities — port below 1024 on ever-works-apps is refused with privileged_port', () => {
		expect(appSecurityRefusals(inputFor(MANAGED), component({ port: 3000 }))).toEqual([]);
		expect(appSecurityRefusals(inputFor(MANAGED), component({ port: 80 }))).toEqual([
			expect.objectContaining({ code: 'privileged_port' })
		]);
	});

	it('§4.4 container capabilities — the same port is not refused on your-cluster', () => {
		expect(appSecurityRefusals(inputFor(YOURS), component({ port: 80 }))).toEqual([]);
		expect(appSecurityRefusals(inputFor(YOURS, true), component({ port: 80 }))).toEqual([]);
	});

	// Row: container `readOnlyRootFilesystem` | `!writableRootFilesystem` | `!writableRootFilesystem`
	it('§4.4 container readOnlyRootFilesystem — !writableRootFilesystem on your-cluster', () => {
		expect(containerSecurityContext(inputFor(YOURS), component()).readOnlyRootFilesystem).toBe(true);
		expect(
			containerSecurityContext(inputFor(YOURS), component({ writableRootFilesystem: true }))
				.readOnlyRootFilesystem
		).toBe(false);
	});

	it('§4.4 container readOnlyRootFilesystem — !writableRootFilesystem on ever-works-apps', () => {
		expect(containerSecurityContext(inputFor(MANAGED), component()).readOnlyRootFilesystem).toBe(true);
		expect(
			containerSecurityContext(inputFor(MANAGED), component({ writableRootFilesystem: true }))
				.readOnlyRootFilesystem
		).toBe(false);
	});
});

describe('tmpVolume — plan §4.4', () => {
	// Row: `/tmp` emptyDir (`sizeLimit: 256Mi`) | when read-only | when read-only
	it('§4.4 /tmp emptyDir — 256Mi and mounted at /tmp when the root filesystem is read-only (your-cluster)', () => {
		const volume = tmpVolume(inputFor(YOURS), component());
		const mount = tmpVolumeMount(inputFor(YOURS), component());

		expect(APP_TMP_VOLUME_SIZE_LIMIT).toBe('256Mi');
		expect(APP_TMP_VOLUME_PATH).toBe('/tmp');
		expect(volume).toEqual({ name: 'tmp', emptyDir: { sizeLimit: '256Mi' } });
		expect(mount).toEqual({ name: 'tmp', mountPath: '/tmp' });
	});

	it('§4.4 /tmp emptyDir — 256Mi when the root filesystem is read-only (ever-works-apps)', () => {
		expect(tmpVolume(inputFor(MANAGED), component())).toEqual({
			name: 'tmp',
			emptyDir: { sizeLimit: '256Mi' }
		});
		expect(tmpVolumeMount(inputFor(MANAGED), component())).toEqual({ name: 'tmp', mountPath: '/tmp' });
	});

	it('§4.4 /tmp emptyDir — absent when the component declares a writable root (complement of the cell)', () => {
		const writable = component({ writableRootFilesystem: true });

		expect(tmpVolume(inputFor(YOURS), writable)).toBeNull();
		expect(tmpVolumeMount(inputFor(YOURS), writable)).toBeNull();
		expect(tmpVolume(inputFor(MANAGED), writable)).toBeNull();
		expect(tmpVolumeMount(inputFor(MANAGED), writable)).toBeNull();
	});
});

describe('namespacePodSecurityLabels — plan §4.4', () => {
	// Row: namespace pod security | enforce `baseline`, warn+audit `restricted` | enforce `restricted`
	it('§4.4 namespace pod security — enforce baseline, warn+audit restricted on your-cluster', () => {
		expect(podSecurityPolicyForTarget(YOURS)).toBe('baseline');
		expect(namespacePodSecurityLabels('baseline')).toEqual({
			'pod-security.kubernetes.io/enforce': 'baseline',
			'pod-security.kubernetes.io/warn': 'restricted',
			'pod-security.kubernetes.io/audit': 'restricted'
		});
	});

	it('§4.4 namespace pod security — enforce restricted on ever-works-apps', () => {
		expect(podSecurityPolicyForTarget(MANAGED)).toBe('restricted');
		expect(namespacePodSecurityLabels(podSecurityPolicyForTarget(MANAGED))).toMatchObject({
			'pod-security.kubernetes.io/enforce': 'restricted'
		});
		expect(namespacePodSecurityLabels('restricted')['pod-security.kubernetes.io/enforce']).toBe('restricted');
	});
});

describe('the numeric-user seam (reported spec gap)', () => {
	/**
	 * Plan §4.4 names no `runAsUser` cell, and the App spec (APW-03 schema §10) has no field for
	 * one — but an image that switches user **by name** (Umami's `nextjs`) is refused by
	 * `runAsNonRoot: true` ("image has non-numeric user", plan §4.4 line 490). This helper
	 * therefore never invents a uid: a caller may supply one, and nothing is emitted otherwise.
	 */
	it('never invents a numeric runAsUser', () => {
		expect(podSecurityContext(inputFor(YOURS), component())).not.toHaveProperty('runAsUser');
		expect(podSecurityContext(inputFor(MANAGED), component())).not.toHaveProperty('runAsUser');
		expect(podSecurityContext(inputFor(YOURS, false, null), component())).not.toHaveProperty('runAsUser');
		expect(containerSecurityContext(inputFor(YOURS), component())).not.toHaveProperty('runAsUser');
	});

	it('passes a caller-supplied numeric runAsUser through unchanged', () => {
		expect(podSecurityContext(inputFor(YOURS, false, APP_RUNNER_RUN_AS_USER), component()).runAsUser).toBe(
			APP_RUNNER_RUN_AS_USER
		);
		expect(APP_RUNNER_RUN_AS_USER).toBe(10001);
		expect(podSecurityContext(inputFor(MANAGED, false, 1234), component()).runAsUser).toBe(1234);
		// A uid must be a non-negative integer: anything else is treated as "not supplied"
		// rather than silently rounded, so no uid is ever invented on the caller's behalf.
		expect(podSecurityContext(inputFor(YOURS, false, -1), component())).not.toHaveProperty('runAsUser');
		expect(podSecurityContext(inputFor(YOURS, false, 10.5), component())).not.toHaveProperty('runAsUser');
		expect(podSecurityContext(inputFor(YOURS, false, Number.NaN), component())).not.toHaveProperty('runAsUser');
	});
});

describe('the §4.4 invariant across the whole table', () => {
	it('no rendered container lacks allowPrivilegeEscalation: false and capabilities.drop: [ALL]', () => {
		const components = [
			component(),
			component({ port: 80 }),
			component({ role: 'worker', port: undefined }),
			component({ writableRootFilesystem: true }),
			component({ volumes: [{ name: 'uploads', path: '/data', size: '1Gi', backup: true }] })
		];

		for (const target of [YOURS, MANAGED] as const) {
			for (const allowRoot of [false, true]) {
				for (const subject of components) {
					const container = containerSecurityContext(inputFor(target, allowRoot), subject);

					expect(container.allowPrivilegeEscalation).toBe(false);
					expect(container.capabilities.drop).toEqual(['ALL']);
					expect(container.readOnlyRootFilesystem).toBe(subject.writableRootFilesystem !== true);
					expect(podSecurityContext(inputFor(target, allowRoot), subject).runAsNonRoot).toBe(
						target === MANAGED ? true : !allowRoot
					);
				}
			}
		}
	});
});

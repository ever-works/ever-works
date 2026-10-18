import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { AppRenderInput } from '@ever-works/plugin';

import { planAppRender } from '../app-manifest.renderer';
import { planAppJobs, renderCommandJob } from '../app-jobs.renderer';

/**
 * **Every rendered pod template declares every volume its containers mount** — the invariant the
 * API server enforces with a 422 (`spec.template.spec.containers[0].volumeMounts[0].name: Not
 * found: "tmp"`), which is how prod Deployment e4b65cbd's `migrate` Job was refused on
 * 2026-10-18: a command Job's read-only container mounted the §4.4 `/tmp` emptyDir and the pod
 * declared no volume at all.
 *
 * The render input is ever-works/app-fixture-hello's spec on the managed target (read-only `web`
 * with an `uploads` volume, read-only `worker`, `migrate` + `bootstrap` command jobs on `web`, the
 * `tick` http cron), plus the existing golden inputs, through BOTH planners — the manifest
 * (Deployments) and the job plan (command Jobs, runner Jobs, CronJobs) — so a new pod template
 * kind cannot slip past.
 */

type Json = Record<string, any>;

function input(file: string, change: (draft: Json) => void = () => undefined): AppRenderInput {
	const draft = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')) as Json;
	change(draft);
	return draft as unknown as AppRenderInput;
}

/** `{ kind/name, podSpec }` for every pod template an object carries (Deployment, Job, CronJob). */
function podTemplates(object: Json): Array<{ where: string; podSpec: Json }> {
	const where = `${object.kind}/${object.metadata?.name}`;
	if (object.kind === 'Deployment' || object.kind === 'Job' || object.kind === 'StatefulSet') {
		return [{ where, podSpec: object.spec?.template?.spec ?? {} }];
	}
	if (object.kind === 'CronJob') {
		return [{ where, podSpec: object.spec?.jobTemplate?.spec?.template?.spec ?? {} }];
	}
	return [];
}

/** Every `volumeMounts[].name` with no `volumes[].name` behind it, as `<where>: <container>/<name>`. */
function undeclaredMounts(objects: readonly Json[]): string[] {
	const missing: string[] = [];
	for (const object of objects) {
		for (const { where, podSpec } of podTemplates(object)) {
			const declared = new Set(((podSpec.volumes ?? []) as Json[]).map((volume) => volume.name));
			for (const container of [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])] as Json[]) {
				for (const mount of (container.volumeMounts ?? []) as Json[]) {
					if (!declared.has(mount.name)) missing.push(`${where}: ${container.name}/${mount.name}`);
				}
			}
		}
	}
	return missing;
}

/** Every object both planners render for one input. */
function everything(renderInput: AppRenderInput): Json[] {
	const manifest = planAppRender(renderInput);
	const jobs = planAppJobs(renderInput, { envChecksum: manifest.envChecksum });
	return [...manifest.objects, ...jobs.objects] as unknown as Json[];
}

const FIXTURE = 'render-input.app-fixture-hello.managed.json';

describe('pod templates declare every volume they mount (volumeMounts ⊆ volumes)', () => {
	it('app-fixture-hello on ever-works-apps: Deployments, command Jobs, runner Jobs', () => {
		const objects = everything(input(FIXTURE));
		const kinds = objects.flatMap((object) => podTemplates(object).map((entry) => entry.where));

		// Vacuity guard: the templates the prod failure was in are actually rendered here.
		expect(kinds).toEqual(
			expect.arrayContaining([
				'Deployment/web',
				'Deployment/worker',
				'Job/job-migrate-e4b65cbd',
				'Job/job-bootstrap-e4b65cbd',
				// A runner Job (the fixture declares no smoke checks, so the probe is the one here).
				'Job/job-isolation-probe-e4b65cbd'
			])
		);
		expect(undeclaredMounts(objects)).toEqual([]);
	});

	it('the migrate Job — the exact prod failure — mounts /tmp and declares it', () => {
		const renderInput = input(FIXTURE);
		const job = renderCommandJob(renderInput, renderInput.jobs[0]) as unknown as Json;
		const podSpec = job.spec.template.spec;

		expect(podSpec.containers[0].volumeMounts).toEqual([{ name: 'tmp', mountPath: '/tmp' }]);
		expect(podSpec.volumes).toEqual([{ name: 'tmp', emptyDir: { sizeLimit: expect.any(String) } }]);
	});

	it('a CronJob template too — http and command crons, read-only and writable', () => {
		const objects = [
			...everything(
				// The fixture's own `*/2` is under the managed minimum (`cron_too_frequent`), so the
				// schedule is relaxed here to make the CronJob render at all.
				input(FIXTURE, (draft) => {
					draft.cron = [
						{ ...draft.cron[0], schedule: '*/5 * * * *' },
						{
							name: 'sweep',
							schedule: '0 * * * *',
							component: 'worker',
							command: ['node', 'src/sweep.mjs']
						}
					];
				})
			)
		];
		const cronJobs = objects.filter((object) => object.kind === 'CronJob').map((object) => object.metadata.name);

		expect(cronJobs).toEqual(expect.arrayContaining(['cron-tick', 'cron-sweep']));
		expect(undeclaredMounts(objects)).toEqual([]);
	});

	it('a writable root filesystem mounts no /tmp and declares none', () => {
		const objects = everything(
			input(FIXTURE, (draft) => {
				for (const component of draft.components) component.writableRootFilesystem = true;
			})
		);
		const migrate = objects.find((object) => object.metadata?.name === 'job-migrate-e4b65cbd') as Json;

		expect(migrate.spec.template.spec.containers[0].volumeMounts).toBeUndefined();
		expect(migrate.spec.template.spec.volumes).toBeUndefined();
		expect(undeclaredMounts(objects)).toEqual([]);
	});

	it.each([
		'render-input.single-web.json',
		'render-input.two-web-components.json',
		'render-input.web-worker-volume.json'
	])('the golden input %s, on both targets', (file) => {
		for (const target of ['your-cluster', 'ever-works-apps']) {
			const objects = everything(
				input(file, (draft) => {
					draft.ref.target = target;
				})
			);
			expect(undeclaredMounts(objects), `${file} on ${target}`).toEqual([]);
		}
	});
});

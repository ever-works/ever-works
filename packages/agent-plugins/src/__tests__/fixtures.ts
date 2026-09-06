import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, FindingCode } from '../findings';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the conformance fixture corpus. */
export const FIXTURES_DIR = resolve(here, '..', '..', 'fixtures');

/** Absolute path of one fixture package. */
export function fixture(name: string): string {
	return join(FIXTURES_DIR, name);
}

/** Every finding code present, for compact assertions. */
export function codes(findings: readonly Finding[]): FindingCode[] {
	return findings.map((f) => f.code);
}

/** Findings carrying a given code. */
export function withCode(findings: readonly Finding[], code: FindingCode): Finding[] {
	return findings.filter((f) => f.code === code);
}

/** The subject of every finding with a given code — usually a skill or server name. */
export function subjectsFor(findings: readonly Finding[], code: FindingCode): string[] {
	return withCode(findings, code)
		.map((f) => f.subject)
		.filter((s): s is string => s !== undefined)
		.sort();
}

/**
 * Creates a symlink at `linkPath` pointing at `target`, returning
 * `undefined` when the platform refuses.
 *
 * Containment tests need real symlinks, and Windows only permits creating
 * them with developer mode or elevation. A suite that hard-failed there
 * would be red on half the team's machines, and one that silently passed
 * would be worse — so a refusal comes back as `undefined` and the caller
 * reports a skip naming the reason.
 *
 * `linkPath` is used exactly as given: the caller owns the directory the
 * link lives in, because a containment test needs the link to sit at a
 * specific place inside the package it is building.
 */
export async function tryMakeSymlink(
	target: string,
	linkPath: string,
	type: 'file' | 'dir' | 'junction' = 'dir'
): Promise<{ link: string } | undefined> {
	try {
		await symlink(target, linkPath, type);
		return { link: linkPath };
	} catch {
		return undefined;
	}
}

/** Absolute path to a scratch directory for a test that needs to build a package. */
export async function scratchDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-plugins-scratch-'));
}

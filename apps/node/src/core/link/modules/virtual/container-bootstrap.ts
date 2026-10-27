import type { FleetVirtualSystemFamily } from '@ever-works/contracts';
import { GUEST_HOME, GUEST_RUN } from './docker-args';

/**
 * Virtual computers (FL-16, plan §6.7, T-15, CONTRACTS R-35) — the script a
 * Container runs as its command. It never contains the enrolment token (or any
 * secret): the token arrives later, in a private file, only once the guest has
 * said it is ready.
 *
 * On first start:
 *   1. install what the runtime needs (the distribution's package manager) and
 *      Node.js — the official build for this processor, checked against the
 *      published SHA-256 list (Alpine: the distribution's own `nodejs`, since
 *      the official builds are glibc-only);
 *   2. `npm install -g ever-works-node@<the host's version>` (one runtime, the
 *      same version as the host so the wire contract matches — plan §15);
 *   3. write the readiness marker `$HOME/.ever-works/ready`;
 *   4. wait for `$HOME/.ever-works/enroll-token` — written by the HOST through
 *      `docker exec -i` from its stdin (so the token touches neither the host's
 *      disk nor any command line), 0600 and owned by the guest — and run
 *      `ever-works-node enroll --token-file` on it, which reads and deletes it;
 *   5. write `$HOME/.ever-works/enrolled` and `exec ever-works-node start
 *      --work --manage` (spec FR-15: no `--attend`).
 *
 * On a restart (the container is kept across Docker restarts) an enrolled guest
 * skips straight to step 5; after a rebuild (a new container, the same home —
 * P3) it reinstalls the runtime and then starts without asking for a token.
 */

export interface ContainerBootstrapInput {
	family: FleetVirtualSystemFamily;
	/** The `ever-works-node` npm spec to install (`ever-works-node@0.2.7`, or an operator override). */
	runtimeSpec: string;
	/** The Node.js major line to install (the host's own). */
	nodeMajor: number;
	/** The API the guest enrols against (the host's). */
	apiUrl: string;
}

/** The guest's markers, read by the host with `docker exec … test -f` (lane decision 9). */
export const GUEST_READY_MARKER = `${GUEST_HOME}/.ever-works/ready`;
export const GUEST_ENROLLED_MARKER = `${GUEST_HOME}/.ever-works/enrolled`;
/** The private token file the host writes into the guest (through `docker exec -i`). */
export const GUEST_TOKEN_FILE = `${GUEST_HOME}/.ever-works/enroll-token`;
/** Where the bootstrap is mounted (read-only, from the host's `run/` folder). */
export const GUEST_BOOTSTRAP = `${GUEST_RUN}/bootstrap.sh`;

const API_URL_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;
const RUNTIME_SPEC_PATTERN = /^ever-works-node(?:@[A-Za-z0-9._+-]{1,64})?$|^https:\/\/[A-Za-z0-9.\/_~%+-]{1,300}\.tgz$/;

/** True when a value may be embedded in the script as a literal (no shell metacharacter can pass). */
export function isBootstrapSafe(input: Pick<ContainerBootstrapInput, 'apiUrl' | 'runtimeSpec' | 'nodeMajor'>): boolean {
	return (
		API_URL_PATTERN.test(input.apiUrl) &&
		RUNTIME_SPEC_PATTERN.test(input.runtimeSpec) &&
		Number.isInteger(input.nodeMajor) &&
		input.nodeMajor >= 18 &&
		input.nodeMajor <= 99
	);
}

/** The package-manager step that installs the prerequisites of one family. */
function prerequisites(family: FleetVirtualSystemFamily): string[] {
	switch (family) {
		case 'ubuntu':
		case 'debian':
			return [
				'export DEBIAN_FRONTEND=noninteractive',
				'apt-get update -qq',
				'apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils git >/dev/null'
			];
		case 'fedora':
			return ['dnf install -y -q curl xz git tar findutils >/dev/null'];
		case 'arch':
			return ['pacman -Sy --noconfirm --needed curl xz git tar >/dev/null'];
		case 'alpine':
			return ['apk add --no-cache ca-certificates curl git nodejs npm >/dev/null'];
		case 'windows':
			throw new Error('a Windows VM is not built from a container bootstrap');
	}
}

/** The official Node.js build, verified against the published checksums (glibc families). */
function officialNode(nodeMajor: number): string[] {
	return [
		'case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) echo "unsupported processor $(uname -m)" >&2; exit 1 ;; esac',
		`NODE_BASE="https://nodejs.org/dist/latest-v${nodeMajor}.x"`,
		'TMP_NODE="$(mktemp -d)"',
		'curl -fsSL "$NODE_BASE/SHASUMS256.txt" -o "$TMP_NODE/SHASUMS256.txt"',
		'NODE_FILE="$(grep -E " node-v[0-9.]+-linux-$NODE_ARCH\\.tar\\.xz$" "$TMP_NODE/SHASUMS256.txt" | head -n 1 | awk \'{print $2}\')"',
		'[ -n "$NODE_FILE" ] || { echo "no Node.js build for linux-$NODE_ARCH" >&2; exit 1; }',
		'curl -fsSL "$NODE_BASE/$NODE_FILE" -o "$TMP_NODE/$NODE_FILE"',
		'(cd "$TMP_NODE" && grep " $NODE_FILE$" SHASUMS256.txt | sha256sum -c - >/dev/null)',
		'tar -xJf "$TMP_NODE/$NODE_FILE" -C /usr/local --strip-components=1',
		'rm -rf "$TMP_NODE"'
	];
}

/** The bootstrap script (POSIX `sh`). Throws when an input could not be embedded safely. */
export function containerBootstrapScript(input: ContainerBootstrapInput): string {
	if (!isBootstrapSafe(input)) throw new Error('the bootstrap inputs did not validate');
	const ready = GUEST_READY_MARKER;
	const enrolled = GUEST_ENROLLED_MARKER;
	const tokenFile = GUEST_TOKEN_FILE;
	const install =
		input.family === 'alpine'
			? prerequisites('alpine')
			: [...prerequisites(input.family), ...officialNode(input.nodeMajor)];
	const lines = [
		'#!/bin/sh',
		'# Ever Works virtual computer bootstrap (generated by the host node; holds no secret).',
		'set -eu',
		`export HOME=${GUEST_HOME}`,
		'export PATH="/usr/local/bin:$PATH"',
		'umask 077',
		'mkdir -p "$HOME/.ever-works"',
		`if [ -f ${enrolled} ] && command -v ever-works-node >/dev/null 2>&1; then`,
		'  exec ever-works-node start --work --manage',
		'fi',
		'if ! command -v ever-works-node >/dev/null 2>&1; then',
		...install.map((line) => `  ${line}`),
		`  npm install -g --no-fund --no-audit --loglevel=error ${input.runtimeSpec}`,
		'fi',
		'# A rebuilt container keeps its home: an enrolled guest starts at once (P3, FR-39).',
		`if [ -f ${enrolled} ]; then`,
		'  exec ever-works-node start --work --manage',
		'fi',
		`: > ${ready}`,
		'# Wait for the host to hand over the one-time token (it asks for it only now).',
		`while [ ! -s ${tokenFile} ]; do sleep 2; done`,
		`ever-works-node enroll --api-url ${input.apiUrl} --token-file ${tokenFile}`,
		`rm -f ${tokenFile}`,
		`: > ${enrolled}`,
		'exec ever-works-node start --work --manage',
		''
	];
	return lines.join('\n');
}

import { accessSync, constants as fsConstants } from 'node:fs';
import { randomInt } from 'node:crypto';
import { posix } from 'node:path';
import {
	fleetVirtualContainerName,
	FLEET_VIRTUAL_WINDOWS_PASSWORD_LENGTH,
	FLEET_VIRTUAL_WINDOWS_USERNAME,
	isFleetImageRef,
	isFleetVirtualName
} from '@ever-works/contracts';
import type { SecretStore } from '../../../secret-store';
import { splitImageDigest, type VirtualImage } from './catalogue';
import { isChildNodeId, VIRTUAL_CHILD_LABEL, VIRTUAL_CONTAINER_LABEL } from './docker-args';
import { mountSpec } from '../machine-facts/docker-ops';
import type { VirtualStateFs } from './state';

/**
 * Virtual computers, phase 2 (FL-16, plan §6.6, T-27 – T-30) — what a Windows
 * VM needs on its host: the KVM probe, the operator-configured installer image,
 * the exact `docker run` argv, the generated password (kept only in this host's
 * OS keychain, or the documented owner-only file fallback), and the first-boot
 * step the installer runs inside Windows.
 *
 * Ever Works names no Windows installer image (spec §8b licensing question,
 * lane decision 14): the operator sets `EVER_WORKS_NODE_VIRTUAL_WINDOWS_IMAGE`
 * to a KVM-backed Windows-in-a-container image (ideally `repository@sha256:…`)
 * whose contract is the one plan §6.6 documents — `VERSION`, `RAM_SIZE`,
 * `CPU_CORES`, `DISK_SIZE`, `USERNAME`, `PASSWORD`, `/storage`, `/oem`, a web
 * viewer on 8006, and a folder shared with the guest (`/shared`, seen in
 * Windows as `\\host.lan\Data` — both overridable). Windows stays unactivated
 * until the owner adds a key inside it (FR-22).
 */

export const WINDOWS_IMAGE_ENV = 'EVER_WORKS_NODE_VIRTUAL_WINDOWS_IMAGE';
export const WINDOWS_SHARE_DIR_ENV = 'EVER_WORKS_NODE_VIRTUAL_WINDOWS_SHARE_DIR';
export const WINDOWS_SHARE_UNC_ENV = 'EVER_WORKS_NODE_VIRTUAL_WINDOWS_SHARE_UNC';
export const DEFAULT_WINDOWS_SHARE_DIR = '/shared';
export const DEFAULT_WINDOWS_SHARE_UNC = '\\\\host.lan\\Data';
/** The installer image's screen viewer, published to the host's loopback only (FR-23). */
export const WINDOWS_VIEWER_PORT = 8006;

// ─── KVM (T-27) ─────────────────────────────────────────────────────────────

export interface KvmProbeDeps {
	platform: string;
	arch: string;
	/** Throws when the path is not readable AND writable by this process. */
	access?: (path: string, mode: number) => void;
}

/** `/dev/kvm` usable by the node's user on Linux x86-64 (CONTRACTS §1.2 `kvm`); never on macOS, Windows or arm64. */
export function kvmUsable(deps: KvmProbeDeps): boolean {
	if (deps.platform !== 'linux' || deps.arch !== 'x64') return false;
	try {
		(deps.access ?? accessSync)('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

// ─── The installer image ────────────────────────────────────────────────────

/** The operator's Windows installer image, or null when none is configured (then no Windows VM here). */
export function resolveWindowsImage(env: NodeJS.ProcessEnv): VirtualImage | null {
	const raw = env[WINDOWS_IMAGE_ENV]?.trim();
	if (!raw || !isFleetImageRef(raw)) return null;
	return { ref: raw, digest: splitImageDigest(raw).digest, source: 'override' };
}

/** Where the installer shares a folder with the guest: the container path and the guest's UNC path. */
export function windowsShare(env: NodeJS.ProcessEnv): { dir: string; unc: string } {
	const dir = env[WINDOWS_SHARE_DIR_ENV]?.trim();
	const unc = env[WINDOWS_SHARE_UNC_ENV]?.trim();
	return {
		dir: dir && /^\/[A-Za-z0-9._\/-]{1,100}$/.test(dir) ? dir : DEFAULT_WINDOWS_SHARE_DIR,
		unc: unc && /^\\\\[A-Za-z0-9.-]{1,63}\\[A-Za-z0-9._$-]{1,63}$/.test(unc) ? unc : DEFAULT_WINDOWS_SHARE_UNC
	};
}

/** The named volume a VM's disk lives in (kept by a stop, removed by a destroy). */
export function storageVolumeName(childNodeId: string): string {
	if (!isChildNodeId(childNodeId)) throw new Error('a virtual computer id must be a uuid');
	return `ew-virtual-${childNodeId}-storage`;
}

export interface WindowsRunInput {
	childNodeId: string;
	name: string;
	image: string;
	/** The installer's `VERSION` (the catalogue's `windowsEdition`: `11`, `10`, `2025`, `2022`). */
	edition: string;
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
	/** 0600 file holding `PASSWORD=…` (removed by the caller once the container exists). */
	envFile: string;
	oemDir: string;
	sharedDir: string;
	shareTarget: string;
}

/**
 * `docker run` for a Windows VM (plan §6.6): KVM, the network capability the
 * installer needs, a 120 s stop timeout (FR-27), the size as the installer's
 * variables, the password through `--env-file` only (never an argv — FR-20),
 * the disk in a named volume, the first-boot step read-only, the shared folder,
 * and the viewer on the host's LOOPBACK at a port Docker picks (FR-23).
 */
export function windowsRunArgs(input: WindowsRunInput): string[] {
	if (!isChildNodeId(input.childNodeId)) throw new Error('a virtual computer id must be a uuid');
	if (!isFleetVirtualName(input.name)) throw new Error('a virtual computer name must match the name pattern');
	if (!/^[0-9]{2,4}$/.test(input.edition)) throw new Error('the Windows edition is not one the catalogue names');
	for (const value of [input.cpus, input.memoryGiB, input.diskGiB]) {
		if (!Number.isInteger(value) || value < 1 || value > 4096) throw new Error('size out of range');
	}
	for (const dir of [input.envFile, input.oemDir, input.sharedDir]) {
		if (!dir.startsWith('/') || dir.includes(','))
			throw new Error('a virtual computer folder must be an absolute path');
	}
	return [
		'run',
		'-d',
		'--name',
		fleetVirtualContainerName(input.childNodeId),
		'--device',
		'/dev/kvm',
		'--cap-add',
		'NET_ADMIN',
		'--stop-timeout',
		'120',
		'--restart',
		'unless-stopped',
		'--label',
		`${VIRTUAL_CONTAINER_LABEL}=true`,
		'--label',
		`${VIRTUAL_CHILD_LABEL}=${input.childNodeId}`,
		'-e',
		`VERSION=${input.edition}`,
		'-e',
		`RAM_SIZE=${input.memoryGiB}G`,
		'-e',
		`CPU_CORES=${input.cpus}`,
		'-e',
		`DISK_SIZE=${input.diskGiB}G`,
		'-e',
		`USERNAME=${FLEET_VIRTUAL_WINDOWS_USERNAME}`,
		'--env-file',
		input.envFile,
		'--mount',
		`type=volume,source=${storageVolumeName(input.childNodeId)},target=/storage`,
		'--mount',
		mountSpec(input.oemDir, '/oem', true),
		'--mount',
		mountSpec(input.sharedDir, input.shareTarget, false),
		'-p',
		`127.0.0.1::${WINDOWS_VIEWER_PORT}`,
		input.image
	];
}

/**
 * Resize (P3): the same container, CREATED (not started) with new sizes — a
 * stopped VM keeps its disk volume, first-boot files and shared folder, and
 * boots with the new size when it is next started.
 */
export function windowsCreateArgs(input: WindowsRunInput): string[] {
	const run = windowsRunArgs(input);
	// `run -d …` → `create …` (every other argument is the same).
	return ['create', ...run.slice(2)];
}

/** `docker port <child> 8006/tcp` → the loopback port Docker picked. */
export function viewerPortArgs(childNodeId: string): string[] {
	return ['port', fleetVirtualContainerName(childNodeId), `${WINDOWS_VIEWER_PORT}/tcp`];
}

/** The host port in `docker port` output (`127.0.0.1:49153`), only when bound to loopback. */
export function parseViewerPort(stdout: string): number | null {
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^127\.0\.0\.1:(\d{1,5})\s*$/.exec(line.trim());
		if (match) {
			const port = Number(match[1]);
			if (port > 0 && port < 65536) return port;
		}
	}
	return null;
}

// ─── The generated password (FR-20, FR-21) ──────────────────────────────────

/** Letters and digits without look-alikes, plus a few symbols every keyboard layout types. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!';

/** A 24-character password from the OS's cryptographic generator, always with each character class. */
export function generateWindowsPassword(random: (max: number) => number = (max) => randomInt(max)): string {
	for (;;) {
		let out = '';
		for (let index = 0; index < FLEET_VIRTUAL_WINDOWS_PASSWORD_LENGTH; index += 1) {
			out += PASSWORD_ALPHABET[random(PASSWORD_ALPHABET.length)];
		}
		if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /[0-9]/.test(out) && /[-_.!]/.test(out)) return out;
	}
}

/** The keychain account a child's password is filed under. */
export function passwordAccount(childNodeId: string): string {
	if (!isChildNodeId(childNodeId)) throw new Error('a virtual computer id must be a uuid');
	return `virtual:${childNodeId.toLowerCase()}`;
}

/**
 * Where a VM's generated password lives: the host's OS keychain, or — when the
 * host has none — an owner-only (0600) file in the child's own folder, the
 * documented fallback, announced loudly once. Never a log line, a job, a
 * platform table or an audit row.
 */
export class WindowsPasswordStore {
	private warned = false;

	constructor(
		private readonly root: string,
		private readonly fs: Pick<VirtualStateFs, 'readFile' | 'writeFile' | 'mkdir'> & {
			removeFile(path: string): Promise<void>;
		},
		private readonly secrets: SecretStore | null,
		private readonly warn: (message: string) => void = () => undefined
	) {}

	private file(childNodeId: string): string {
		return posix.join(this.root, childNodeId.toLowerCase(), 'password');
	}

	async set(childNodeId: string, password: string): Promise<void> {
		if (this.secrets) {
			await this.secrets.set(passwordAccount(childNodeId), password);
			return;
		}
		if (!this.warned) {
			this.warned = true;
			this.warn(
				'No OS keychain on this host: Windows VM passwords are kept in owner-only (0600) files under the node’s virtual data folder.'
			);
		}
		await this.fs.mkdir(posix.join(this.root, childNodeId.toLowerCase()));
		await this.fs.writeFile(this.file(childNodeId), password, 0o600);
	}

	async get(childNodeId: string): Promise<string | null> {
		if (this.secrets) return this.secrets.get(passwordAccount(childNodeId));
		const raw = await this.fs.readFile(this.file(childNodeId));
		return raw && raw.length > 0 ? raw : null;
	}

	async delete(childNodeId: string): Promise<void> {
		if (this.secrets) await this.secrets.delete(passwordAccount(childNodeId));
		await this.fs.removeFile(this.file(childNodeId)).catch(() => undefined);
	}
}

// ─── The first-boot step (T-28) ─────────────────────────────────────────────

export interface WindowsFirstBootInput {
	runtimeSpec: string;
	nodeMajor: number;
	apiUrl: string;
	/** The guest's UNC path of the shared folder. */
	shareUnc: string;
}

/** Markers the first-boot step writes into the shared folder (the host reads them there). */
export const WINDOWS_BOOTED_MARKER = 'booted.txt';
export const WINDOWS_READY_MARKER = 'ready.txt';
export const WINDOWS_ENROLLED_MARKER = 'enrolled.txt';
export const WINDOWS_TOKEN_FILE = 'enroll-token';

const API_URL_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;
const RUNTIME_SPEC_PATTERN = /^ever-works-node(?:@[A-Za-z0-9._+-]{1,64})?$|^https:\/\/[A-Za-z0-9.\/_~%+-]{1,300}\.tgz$/;

/**
 * The installer runs `install.bat` from `/oem` at Windows' first logon, as
 * the generated account; it starts the PowerShell step. Neither file holds a
 * token or a password: the password was set by the installer from its
 * environment, the token arrives later through the shared folder.
 */
export function windowsInstallBat(): string {
	return [
		'@echo off',
		'rem Ever Works virtual computer first boot (generated by the host node; holds no secret).',
		'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ever-works-first-boot.ps1" > "%ProgramData%\\ever-works-first-boot.log" 2>&1',
		''
	].join('\r\n');
}

/**
 * The first-boot step (FR-25): tell the host it booted, install the official
 * Node.js build of the host's line (checked against the published SHA-256
 * list) and the host's `ever-works-node`, say it is ready, wait for the token
 * in the shared folder, copy it to an owner-only file and `enroll
 * --token-file` it (which deletes it), then register the runtime to start at
 * boot as THIS generated account — a Scheduled Task with the S4U logon type,
 * which needs no stored password and is never a built-in system account — and
 * say it enrolled.
 */
export function windowsFirstBootScript(input: WindowsFirstBootInput): string {
	if (!API_URL_PATTERN.test(input.apiUrl)) throw new Error('the API URL did not validate');
	if (!RUNTIME_SPEC_PATTERN.test(input.runtimeSpec)) throw new Error('the runtime spec did not validate');
	if (!Number.isInteger(input.nodeMajor) || input.nodeMajor < 18 || input.nodeMajor > 99) {
		throw new Error('the Node.js line did not validate');
	}
	if (!/^\\\\[A-Za-z0-9.-]{1,63}\\[A-Za-z0-9._$-]{1,63}$/.test(input.shareUnc))
		throw new Error('the share did not validate');
	return [
		'# Ever Works virtual computer first boot (generated by the host node; holds no secret).',
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		`$share = '${input.shareUnc}'`,
		"$base = Join-Path $env:ProgramData 'EverWorks'",
		'New-Item -ItemType Directory -Force -Path $base | Out-Null',
		`Set-Content -Path (Join-Path $share '${WINDOWS_BOOTED_MARKER}') -Value 'booted'`,
		`$nodeBase = 'https://nodejs.org/dist/latest-v${input.nodeMajor}.x'`,
		'$sums = (Invoke-WebRequest -UseBasicParsing "$nodeBase/SHASUMS256.txt").Content',
		'$line = ($sums -split "`n" | Where-Object { $_ -match \' node-v[0-9.]+-x64\\.msi$\' } | Select-Object -First 1).Trim()',
		"$hash, $file = $line -split '\\s+'",
		'$msi = Join-Path $env:TEMP $file',
		'Invoke-WebRequest -UseBasicParsing "$nodeBase/$file" -OutFile $msi',
		"if ((Get-FileHash -Algorithm SHA256 $msi).Hash.ToLower() -ne $hash.ToLower()) { throw 'the Node.js download did not match its checksum' }",
		"Start-Process msiexec.exe -ArgumentList '/i', $msi, '/qn', '/norestart' -Wait",
		"$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')",
		`& npm.cmd install -g --no-fund --no-audit --loglevel=error ${input.runtimeSpec}`,
		"if ($LASTEXITCODE -ne 0) { throw 'the node runtime did not install' }",
		`Set-Content -Path (Join-Path $share '${WINDOWS_READY_MARKER}') -Value 'ready'`,
		`$shared = Join-Path $share '${WINDOWS_TOKEN_FILE}'`,
		'while (-not (Test-Path $shared) -or ((Get-Item $shared).Length -eq 0)) { Start-Sleep -Seconds 3 }',
		"$private = Join-Path $base 'enroll-token'",
		'Copy-Item $shared $private -Force',
		'icacls $private /inheritance:r /grant:r "$($env:USERNAME):(R,W,D)" | Out-Null',
		`& ever-works-node.cmd enroll --api-url ${input.apiUrl} --token-file $private`,
		"if ($LASTEXITCODE -ne 0) { throw 'enrolment failed' }",
		'Remove-Item -Force -ErrorAction SilentlyContinue $private',
		'$runtime = (Get-Command ever-works-node.cmd).Source',
		"$action = New-ScheduledTaskAction -Execute $runtime -Argument 'start --work --manage'",
		'$trigger = New-ScheduledTaskTrigger -AtStartup',
		'$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited',
		"Register-ScheduledTask -TaskName 'Ever Works node' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null",
		"Start-ScheduledTask -TaskName 'Ever Works node'",
		`Set-Content -Path (Join-Path $share '${WINDOWS_ENROLLED_MARKER}') -Value 'enrolled'`,
		''
	].join('\r\n');
}

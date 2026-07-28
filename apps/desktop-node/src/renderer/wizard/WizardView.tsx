import { useEffect, useState } from 'react';
import type { ApiHostOption, DesktopNodeBridge, NodeIdentityView, NodeResourceLimits } from '../../shared/ipc-contract';
import {
	DEFAULT_LIMITS_VIEW,
	MAX_CONCURRENCY,
	MAX_CPU_CEILING,
	MIN_CONCURRENCY,
	MIN_CPU_CEILING,
	MIN_MEMORY_CEILING_MB
} from '../../shared/ipc-contract';
import {
	canAdvance,
	computeStepList,
	enrollMode,
	nextStep,
	normalizeLimits,
	previousStep,
	resolveApiUrl,
	signInInputValid,
	type WizardProgress,
	type WizardStepId
} from './steps';

interface WizardViewProps {
	bridge: DesktopNodeBridge;
	onEnrolled(identity: NodeIdentityView): void;
}

const STEP_TITLES: Record<WizardStepId, string> = {
	welcome: 'Welcome',
	host: 'Choose your API host',
	token: 'Connect your account',
	capabilities: 'Choose what this machine offers',
	limits: 'Set resource limits',
	enroll: 'Enroll this machine',
	running: 'Running'
};

/** Tags that describe the machine itself — always advertised, never a choice. */
function isIdentityTag(tag: string): boolean {
	return tag.startsWith('os:') || tag.startsWith('arch:') || tag.startsWith('node:');
}

/**
 * Setup wizard: welcome → API host → credentials → capabilities → limits →
 * enroll → running. All sequencing decisions live in `steps.ts`; this component
 * only renders them and calls the bridge.
 */
export function WizardView({ bridge, onEnrolled }: WizardViewProps) {
	const [step, setStep] = useState<WizardStepId>('welcome');
	const [progress, setProgress] = useState<WizardProgress>({ enrolled: false });
	const [hosts, setHosts] = useState<ApiHostOption[]>([]);
	const [detected, setDetected] = useState<string[]>([]);
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [signedInAs, setSignedInAs] = useState<string | null>(null);

	useEffect(() => {
		void bridge.listApiHosts().then(setHosts);
		void bridge.detectCapabilities().then((tags) => {
			setDetected(tags);
			// Default the offer to everything detected: the step is a chance to
			// narrow, not a wall of unchecked boxes standing between the
			// operator and a working node.
			setProgress((current) =>
				current.capabilities === undefined ? { ...current, capabilities: [...tags] } : current
			);
		});
	}, [bridge]);

	const steps = computeStepList(progress);
	const apiUrl = resolveApiUrl(progress);
	const mode = enrollMode(progress);
	const selectable = detected.filter((tag) => !isIdentityTag(tag));
	const identityTags = detected.filter(isIdentityTag);
	const limits = progress.limits ?? DEFAULT_LIMITS_VIEW;

	const advance = () => {
		const next = nextStep(step, progress);
		if (next) {
			setStep(next);
		}
	};

	const patchLimits = (patch: Partial<NodeResourceLimits>) =>
		setProgress((current) => ({
			...current,
			limits: normalizeLimits({ ...(current.limits ?? DEFAULT_LIMITS_VIEW), ...patch })
		}));

	const toggleCapability = (tag: string) =>
		setProgress((current) => {
			const chosen = current.capabilities ?? [];
			return {
				...current,
				capabilities: chosen.includes(tag) ? chosen.filter((entry) => entry !== tag) : [...chosen, tag]
			};
		});

	// A14 — verify credentials here so a typo fails at this step rather than
	// three steps later during enrollment.
	const runSignIn = async () => {
		setBusy(true);
		setError(null);
		try {
			const outcome = await bridge.authenticate({
				host: progress.host as ApiHostOption['id'],
				...(progress.customApiUrl ? { apiUrl: progress.customApiUrl } : {}),
				email: progress.email ?? '',
				password: progress.password ?? ''
			});
			if (!outcome.ok) {
				setSignedInAs(null);
				setProgress((current) => ({ ...current, signedIn: false }));
				setError(outcome.error ?? 'Sign-in failed.');
				return;
			}
			setSignedInAs(outcome.email ?? progress.email ?? null);
			setProgress((current) => ({ ...current, signedIn: true }));
		} finally {
			setBusy(false);
		}
	};

	const runEnrollment = async () => {
		setBusy(true);
		setError(null);
		try {
			const outcome = await bridge.enroll({
				host: progress.host as ApiHostOption['id'],
				...(progress.customApiUrl ? { apiUrl: progress.customApiUrl } : {}),
				mode,
				...(mode === 'sign-in'
					? { email: progress.email ?? '', password: progress.password ?? '' }
					: { token: progress.token ?? '' }),
				...(name.trim() ? { name: name.trim() } : {}),
				...(progress.capabilities ? { capabilities: progress.capabilities } : {}),
				limits: normalizeLimits(limits)
			});
			if (!outcome.ok || !outcome.identity) {
				setError(outcome.error ?? 'Enrollment failed.');
				return;
			}
			// Drop the password from renderer state the moment it is no longer
			// needed — it never had to outlive the request.
			setProgress((current) => ({ ...current, enrolled: true, password: '' }));
			setStep('running');
			onEnrolled(outcome.identity);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="shell">
			<h1>Ever Works Desktop Node</h1>
			<p className="muted">Lend this machine to the platform as an execution node.</p>

			<div className="steps-nav">
				{steps.map((candidate) => (
					<span
						key={candidate}
						className={`step ${candidate === step ? 'active' : ''} ${
							canAdvance(candidate, progress) && candidate !== step ? 'done' : ''
						}`}
					>
						{STEP_TITLES[candidate]}
					</span>
				))}
			</div>

			<div className="panel">
				<h2>{STEP_TITLES[step]}</h2>

				{step === 'welcome' && (
					<>
						<p className="muted">
							This app registers this machine with an Ever Works platform, then keeps it visible in the
							Fleet settings page with a regular heartbeat. Nothing listens for inbound connections — the
							node only makes outbound requests.
						</p>
						<p className="muted">Detected capabilities:</p>
						<div className="tags">
							{detected.map((tag) => (
								<span className="badge" key={tag}>
									{tag}
								</span>
							))}
						</div>
					</>
				)}

				{step === 'host' && (
					<>
						{hosts.map((host) => (
							<div
								className={`host-card ${progress.host === host.id ? 'selected' : ''}`}
								key={host.id}
								onClick={() => setProgress((current) => ({ ...current, host: host.id }))}
							>
								<strong>{host.label}</strong>
								<span className="muted">{host.description}</span>
								{host.url && <span className="muted">{host.url}</span>}
							</div>
						))}
						{progress.host === 'self-hosted' && (
							<label className="field">
								<span>API base URL</span>
								<input
									type="text"
									placeholder="https://works.example.com"
									value={progress.customApiUrl ?? ''}
									onChange={(event) =>
										setProgress((current) => ({ ...current, customApiUrl: event.target.value }))
									}
								/>
							</label>
						)}
						{apiUrl && <p className="muted">Will enroll against {apiUrl}</p>}
					</>
				)}

				{step === 'token' && (
					<>
						<div className="steps-nav">
							<button
								className={mode === 'sign-in' ? '' : 'secondary'}
								onClick={() =>
									setProgress((current) => ({ ...current, mode: 'sign-in', signedIn: false }))
								}
							>
								Sign in
							</button>
							<button
								className={mode === 'token' ? '' : 'secondary'}
								onClick={() => setProgress((current) => ({ ...current, mode: 'token' }))}
							>
								Paste a token
							</button>
						</div>

						{mode === 'sign-in' ? (
							<>
								<p className="muted">
									Sign in with your Ever Works account and this app will issue its own one-time
									enrollment token — no copying anything between windows.
								</p>
								<label className="field">
									<span>Email</span>
									<input
										type="email"
										autoComplete="username"
										value={progress.email ?? ''}
										onChange={(event) =>
											setProgress((current) => ({
												...current,
												email: event.target.value,
												signedIn: false
											}))
										}
									/>
								</label>
								<label className="field">
									<span>Password</span>
									<input
										type="password"
										autoComplete="current-password"
										value={progress.password ?? ''}
										onChange={(event) =>
											setProgress((current) => ({
												...current,
												password: event.target.value,
												signedIn: false
											}))
										}
									/>
								</label>
								<div className="actions">
									<button
										disabled={busy || !signInInputValid(progress)}
										onClick={() => void runSignIn()}
									>
										{busy ? 'Signing in…' : 'Sign in'}
									</button>
								</div>
								{progress.signedIn && (
									<p className="muted">Signed in{signedInAs ? ` as ${signedInAs}` : ''}.</p>
								)}
							</>
						) : (
							<>
								<p className="muted">
									Open the platform’s Fleet settings page, choose “Add node”, and copy the one-time
									enrollment token. It is single-use and expires 15 minutes after it is issued.
								</p>
								<label className="field">
									<span>Enrollment token</span>
									<input
										type="password"
										value={progress.token ?? ''}
										onChange={(event) =>
											setProgress((current) => ({ ...current, token: event.target.value }))
										}
									/>
								</label>
							</>
						)}

						<label className="field">
							<span>Local label (optional)</span>
							<input type="text" value={name} onChange={(event) => setName(event.target.value)} />
						</label>
						{error && <div className="error-note">{error}</div>}
					</>
				)}

				{step === 'capabilities' && (
					<>
						<p className="muted">
							Pick what this machine offers the platform. Unchecking a capability means work that needs it
							is never scheduled here — including after you install the tool later.
						</p>
						{selectable.length === 0 ? (
							<p className="muted">Nothing optional was detected on this machine.</p>
						) : (
							selectable.map((tag) => (
								<label className="field" key={tag}>
									<span>
										<input
											type="checkbox"
											checked={(progress.capabilities ?? []).includes(tag)}
											onChange={() => toggleCapability(tag)}
										/>{' '}
										{tag}
									</span>
								</label>
							))
						)}
						<p className="muted">Always reported (machine identity):</p>
						<div className="tags">
							{identityTags.map((tag) => (
								<span className="badge" key={tag}>
									{tag}
								</span>
							))}
						</div>
					</>
				)}

				{step === 'limits' && (
					<>
						<p className="muted">
							Ceilings this machine enforces on itself. The platform is never asked to respect them — the
							node simply stops leasing new work when a ceiling is reached. Jobs already running always
							finish and report.
						</p>
						<label className="field">
							<span>Max jobs at once</span>
							<input
								type="number"
								min={MIN_CONCURRENCY}
								max={MAX_CONCURRENCY}
								value={limits.maxConcurrentJobs}
								onChange={(event) => patchLimits({ maxConcurrentJobs: Number(event.target.value) })}
							/>
						</label>
						<label className="field">
							<span>
								<input
									type="checkbox"
									checked={limits.maxCpuPercent !== null}
									onChange={(event) =>
										patchLimits({ maxCpuPercent: event.target.checked ? 80 : null })
									}
								/>{' '}
								Pause new work above a CPU ceiling
							</span>
							{limits.maxCpuPercent !== null && (
								<input
									type="number"
									min={MIN_CPU_CEILING}
									max={MAX_CPU_CEILING}
									value={limits.maxCpuPercent}
									onChange={(event) => patchLimits({ maxCpuPercent: Number(event.target.value) })}
								/>
							)}
						</label>
						<label className="field">
							<span>
								<input
									type="checkbox"
									checked={limits.maxMemoryMb !== null}
									onChange={(event) =>
										patchLimits({ maxMemoryMb: event.target.checked ? 4096 : null })
									}
								/>{' '}
								Pause new work above a memory ceiling (MB in use)
							</span>
							{limits.maxMemoryMb !== null && (
								<input
									type="number"
									min={MIN_MEMORY_CEILING_MB}
									step={256}
									value={limits.maxMemoryMb}
									onChange={(event) => patchLimits({ maxMemoryMb: Number(event.target.value) })}
								/>
							)}
						</label>
					</>
				)}

				{step === 'enroll' && (
					<>
						<p className="muted">
							Ready to enroll against <strong>{apiUrl}</strong>
							{mode === 'sign-in' ? ' using your signed-in account' : ' with your pasted token'}.
						</p>
						<p className="muted">Offering:</p>
						<div className="tags">
							{[...identityTags, ...(progress.capabilities ?? [])].map((tag) => (
								<span className="badge" key={tag}>
									{tag}
								</span>
							))}
						</div>
						<p className="muted">
							Up to {limits.maxConcurrentJobs} job(s) at once
							{limits.maxCpuPercent === null ? '' : `, CPU below ${limits.maxCpuPercent}%`}
							{limits.maxMemoryMb === null ? '' : `, memory in use below ${limits.maxMemoryMb}MB`}.
						</p>
						{error && <div className="error-note">{error}</div>}
						<div className="actions">
							<button disabled={busy} onClick={() => void runEnrollment()}>
								{busy ? 'Enrolling…' : 'Enroll this machine'}
							</button>
						</div>
					</>
				)}

				{step === 'running' && (
					<p className="muted">
						Enrolled. This machine now appears in the Fleet settings page and will report a heartbeat
						continuously. You can pause work at any time from the status window or the tray.
					</p>
				)}
			</div>

			{step !== 'enroll' && step !== 'running' && (
				<div className="actions">
					<button
						className="secondary"
						disabled={previousStep(step, progress) === null}
						onClick={() => {
							const back = previousStep(step, progress);
							if (back) {
								setStep(back);
							}
						}}
					>
						Back
					</button>
					<button disabled={!canAdvance(step, progress)} onClick={advance}>
						Continue
					</button>
				</div>
			)}
		</div>
	);
}

import { useEffect, useState } from 'react';
import type { ApiHostOption, DesktopNodeBridge, NodeIdentityView } from '../../shared/ipc-contract';
import {
	canAdvance,
	computeStepList,
	nextStep,
	previousStep,
	resolveApiUrl,
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
	token: 'Paste your enrollment token',
	enroll: 'Enroll this machine',
	running: 'Running'
};

/**
 * Setup wizard: welcome → API host → token → enroll → running.
 * All sequencing decisions live in `steps.ts`; this component only renders
 * them and calls the bridge.
 */
export function WizardView({ bridge, onEnrolled }: WizardViewProps) {
	const [step, setStep] = useState<WizardStepId>('welcome');
	const [progress, setProgress] = useState<WizardProgress>({ enrolled: false });
	const [hosts, setHosts] = useState<ApiHostOption[]>([]);
	const [capabilities, setCapabilities] = useState<string[]>([]);
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void bridge.listApiHosts().then(setHosts);
		void bridge.detectCapabilities().then(setCapabilities);
	}, [bridge]);

	const steps = computeStepList(progress);
	const apiUrl = resolveApiUrl(progress);

	const advance = () => {
		const next = nextStep(step, progress);
		if (next) {
			setStep(next);
		}
	};

	const runEnrollment = async () => {
		setBusy(true);
		setError(null);
		try {
			const outcome = await bridge.enroll({
				host: progress.host as ApiHostOption['id'],
				...(progress.customApiUrl ? { apiUrl: progress.customApiUrl } : {}),
				token: progress.token ?? '',
				...(name.trim() ? { name: name.trim() } : {})
			});
			if (!outcome.ok || !outcome.identity) {
				setError(outcome.error ?? 'Enrollment failed.');
				return;
			}
			setProgress((current) => ({ ...current, enrolled: true }));
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
							{capabilities.map((tag) => (
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
						<p className="muted">
							Open the platform’s Fleet settings page, choose “Add node”, and copy the one-time enrollment
							token. It is single-use and expires 15 minutes after it is issued.
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
						<label className="field">
							<span>Local label (optional)</span>
							<input type="text" value={name} onChange={(event) => setName(event.target.value)} />
						</label>
					</>
				)}

				{step === 'enroll' && (
					<>
						<p className="muted">
							Ready to enroll against <strong>{apiUrl}</strong> with{' '}
							{capabilities.length || 'no detected'} capability tags.
						</p>
						<div className="tags">
							{capabilities.map((tag) => (
								<span className="badge" key={tag}>
									{tag}
								</span>
							))}
						</div>
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
						continuously.
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

import { useEffect, useState } from 'react';
import type { DesktopConfig } from '../shared/ipc-contract';
import { StatusScreen } from './StatusScreen';
import { WizardView } from './wizard/WizardView';

export function App() {
	const bridge = window.everworks;
	const [config, setConfig] = useState<DesktopConfig | undefined>();

	useEffect(() => {
		void bridge?.getConfig().then(setConfig);
	}, [bridge]);

	if (!bridge) {
		return (
			<div className="shell">
				<h1>Ever Works Desktop</h1>
				<p className="muted">
					The desktop bridge is unavailable — this UI must run inside the Electron shell (pnpm start). The
					vite dev server alone renders the wizard without live checks.
				</p>
			</div>
		);
	}

	if (!config) {
		return (
			<div className="shell">
				<p className="muted">Loading…</p>
			</div>
		);
	}

	if (!config.wizardCompleted) {
		return <WizardView bridge={bridge} onCompleted={() => setConfig({ ...config, wizardCompleted: true })} />;
	}

	return <StatusScreen bridge={bridge} />;
}

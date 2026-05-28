import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components';

export interface AgentSummaryTemplateProps {
	readonly agentName: string;
	readonly summary: string;
	readonly taskCount: number;
	readonly dashboardUrl: string;
}

const main = { fontFamily: '-apple-system, system-ui, sans-serif', color: '#111', padding: '16px' };
const muted = { color: '#888', fontSize: '12px' };
const button = {
	display: 'inline-block',
	padding: '8px 14px',
	background: '#111',
	color: '#fff',
	textDecoration: 'none',
	borderRadius: '6px'
};

export function AgentSummaryEmail(props: AgentSummaryTemplateProps) {
	const { agentName, summary, taskCount, dashboardUrl } = props;
	const taskLabel = `${taskCount} task${taskCount === 1 ? '' : 's'} processed`;
	return (
		<Html>
			<Head />
			<Preview>{`${agentName} — daily summary · ${taskLabel}`}</Preview>
			<Body style={main}>
				<Container>
					<Heading as="h2">{agentName}</Heading>
					<Text style={{ color: '#444' }}>{`Daily summary · ${taskLabel}`}</Text>
					<Text>{summary}</Text>
					<Section>
						<Button href={dashboardUrl} style={button}>
							Open dashboard
						</Button>
					</Section>
					<Hr style={{ borderColor: '#eee', margin: '24px 0' }} />
					<Text style={muted}>{`Sent by Ever Works on behalf of ${agentName}.`}</Text>
				</Container>
			</Body>
		</Html>
	);
}

export default AgentSummaryEmail;

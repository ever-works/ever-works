import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components';

export interface AgentMessageTemplateProps {
	readonly fromAgent: string;
	readonly toAgent: string;
	readonly subject: string;
	readonly body: string;
	readonly contextUrl?: string;
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

export function AgentMessageEmail(props: AgentMessageTemplateProps) {
	const { fromAgent, toAgent, subject, body, contextUrl } = props;
	return (
		<Html>
			<Head />
			<Preview>{subject}</Preview>
			<Body style={main}>
				<Container>
					<Text style={muted}>
						{'From: '}
						<b>{fromAgent}</b>
						{' → To: '}
						<b>{toAgent}</b>
					</Text>
					<Heading as="h3" style={{ margin: '8px 0 14px' }}>
						{subject}
					</Heading>
					{/* Preserve sender line breaks in the rendered body. */}
					<Section style={{ lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>
						<Text>{body}</Text>
					</Section>
					{contextUrl ? (
						<Section>
							<Button href={contextUrl} style={button}>
								Open in dashboard
							</Button>
						</Section>
					) : null}
					<Hr style={{ borderColor: '#eee', margin: '24px 0' }} />
					<Text style={muted}>Agent-to-agent message via Ever Works.</Text>
				</Container>
			</Body>
		</Html>
	);
}

export default AgentMessageEmail;

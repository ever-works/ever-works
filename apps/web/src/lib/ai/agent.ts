import 'server-only';
import {
    convertToModelMessages,
    streamText,
    stepCountIs,
    type UIMessage,
    type StreamTextOnFinishCallback,
} from 'ai';
import { createBackendProvider } from './provider';
import { chatTools } from './tools';
import { API_URL } from '@/lib/constants';

const MAX_TOOL_STEPS = 50;

const SYSTEM_PROMPT = `You are an AI assistant for Ever Works, a directory builder platform.
You help users manage directories, generate content, deploy websites, and configure their setup.
ALWAYS use tools to fetch or mutate data — never guess or make up information.

## RULES

1. **Always summarize** after a tool call — tell the user what happened in plain language.
2. **navigate and reloadPage are silent** — never write text after calling them.
3. **After mutations** (create, update, delete, enable, disable, deploy, generate) — write summary first, then call reloadPage as the last action.
4. **Ask before acting** when details are missing — never pick random values. Ask for name, cadence, URL, etc.
5. **Use context** — if the URL contains a directory UUID, use it. Never ask for what's in the URL.

## PREREQUISITES

- **Creating a directory**: checkGitConnection first. If not connected, the UI shows a connect button.
- **Generating items (first time)**: call listAvailablePipelines to show the user available pipelines and providers. Each pipeline has different needs — some require AI provider, search, screenshot; others are self-contained. Let the user choose before proceeding.
- **Generating items (retry)**: just call generateItems with the directoryId — it reuses the previous configuration automatically.
- **Deploying**: checkGitConnection AND checkDeployConnection. Both required.

## GENERATION FLOW

For first-time generation or when user wants to change pipeline:
1. Call listAvailablePipelines (with directoryId if exists, without for new directories)
2. Present the available pipelines and their provider options to the user
3. The response shows which provider categories each pipeline needs — this is dynamic per pipeline
4. Let user choose, then pass their selections to createDirectoryWithAI or generateItems

For retries or re-runs:
- Just call generateItems(directoryId) — it automatically reuses the last prompt, pipeline, providers, and plugin config.

## CURRENT CONTEXT
{context}

Be concise. Use markdown for formatting.`;

interface AgentOptions {
    messages: UIMessage[];
    authToken: string;
    providerOverride: string;
    directoryId?: string;
    conversationId?: string;
    currentPageUrl?: string;
    onFinish?: StreamTextOnFinishCallback<typeof chatTools>;
}

export async function runAgent({
    messages,
    authToken,
    providerOverride,
    directoryId,
    conversationId,
    currentPageUrl,
    onFinish,
}: AgentOptions) {
    const provider = createBackendProvider({
        baseURL: `${API_URL}/v1`,
        authToken,
        providerOverride,
        directoryId,
        conversationId,
    });

    const context = currentPageUrl
        ? `The user is currently viewing: ${currentPageUrl}`
        : 'The user is on the dashboard.';

    return streamText({
        model: provider.chatModel('auto'),
        system: SYSTEM_PROMPT.replace('{context}', context),
        messages: await convertToModelMessages(messages),
        tools: chatTools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
        onFinish,
    });
}

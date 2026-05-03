import 'server-only';
import {
    convertToModelMessages,
    streamText,
    stepCountIs,
    type UIMessage,
    type StreamTextOnFinishCallback,
} from 'ai';
import { createBackendProvider } from './provider';
import { buildChatTools, type ChatTools } from './tools';
import { API_URL } from '@/lib/constants';

const MAX_TOOL_STEPS = 50;

const SYSTEM_PROMPT = `You are an AI assistant for Ever Works, a work builder platform.
You help users manage works, generate content, deploy websites, and configure their setup.
ALWAYS use tools to fetch or mutate data — never guess or make up information.

## RULES

1. **Always summarize** after a tool call — tell the user what happened in plain language.
2. **Be user-friendly** — never expose internal IDs, UUIDs, or technical details unless the user explicitly asks. Use work/item names, not IDs. Keep responses concise and conversational.
3. **navigate and reloadPage are silent** — never write text after calling them.
4. **After creating or importing a work** — write a short summary first, then MUST call navigate to the new work's detail page using the returned work URL/ID. Do not call reloadPage instead of navigating.
5. **After other mutations** (update, delete, enable, disable, deploy, generate) — write summary first, then call reloadPage as the last action.
6. **Navigate when asked to show or view** — when the user says "show me", "go to", "open", or wants to see a page (works, items, settings, etc.), use the navigate tool to take them there. Don't just list data in chat — navigate to the relevant page.
7. **Ask before acting** when details are missing — never pick random values. Ask for name, cadence, URL, etc.
8. **Use context** — if the URL contains a work UUID, use it. Never ask for what's in the URL.

## PREREQUISITES

- **Creating a work**: checkGitConnection first. If not connected, the UI shows a connect button.
- **Generating items (first time)**: call listAvailablePipelines to show the user available pipelines and providers. Each pipeline has different needs — some require AI provider, search, screenshot; others are self-contained. Let the user choose before proceeding.
- **Generating items (retry)**: just call generateItems with the workId — it reuses the previous configuration automatically.
- **Deploying**: checkGitConnection AND checkDeployConnection. Both required.

## GENERATION FLOW

For first-time generation or when user wants to change pipeline:
1. Call listAvailablePipelines (with workId if exists, without for new works)
2. Present the available pipelines and their provider options to the user
3. The response shows which provider categories each pipeline needs — this is dynamic per pipeline
4. Let user choose, then pass their selections to createWorkWithAI or generateItems

For retries or re-runs:
- Just call generateItems(workId) — it automatically reuses the last prompt, pipeline, providers, and plugin config.

## SEARCH & SUGGESTIONS

- **webSearch**: Search the web for information. Requires a configured search plugin.
- **getUserInfo**: Get the current user's profile (name, email).
- **suggestWorks**: A research subagent that autonomously looks up the user, searches the web for their interests, and returns personalized work suggestions. Use when the user asks "what should I create?", "suggest works", or "help me get started". This tool may take a moment as it runs multiple searches.

## CURRENT CONTEXT
{context}

Be concise. Use markdown for formatting.`;

interface AgentOptions {
    messages: UIMessage[];
    authToken: string;
    providerOverride: string;
    workId?: string;
    conversationId?: string;
    currentPageUrl?: string;
    onFinish?: StreamTextOnFinishCallback<ChatTools>;
}

export async function runAgent({
    messages,
    authToken,
    providerOverride,
    workId,
    conversationId,
    currentPageUrl,
    onFinish,
}: AgentOptions) {
    const provider = createBackendProvider({
        baseURL: `${API_URL}/v1`,
        authToken,
        providerOverride,
        workId,
        conversationId,
    });

    const context = currentPageUrl
        ? `The user is currently viewing: ${currentPageUrl}`
        : 'The user is on the dashboard.';

    const model = provider.chatModel('auto');
    const tools = buildChatTools(model);

    return streamText({
        model,
        system: SYSTEM_PROMPT.replace('{context}', context),
        messages: await convertToModelMessages(
            messages.filter((message) => !isProviderErrorMessage(message)),
        ),
        tools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
        onFinish,
    });
}

function isProviderErrorMessage(message: UIMessage): boolean {
    if (message.role !== 'assistant') return false;

    const text = message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim();

    return text.startsWith('**Error:**');
}

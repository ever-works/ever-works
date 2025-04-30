import { HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { Logger } from "@nestjs/common";
import { z } from "zod";

const routes = {
    software: 'when user asks for software, SaaS services etc.',
    dev: 'when user asks for development tools, libraries, frameworks etc.',
    other: 'when user asks for something else - general route',
}

function getKeys<T, K = keyof T>(obj: T) {
    return Object.keys(obj) as [K]; // hack to get correct type for Zod enum
}

const allowedRoutes = getKeys(routes);

export const ROUTER_PROMPT = `
You are directory website builder and your task is to route items to the correct specialized subagent based on their features and descriptions.
Take a look at task given by user as it may contain some hints about route:
<task>
{task}
</task>

Sometimes user may include URLs inside task, so please include them in response if you find any.

Here is the list of routes:
<routes>
{routes}
</routes>
`.trim().replace('{routes}', getRoutes());

function getRoutes(): string {
    let str = '';
    for (const route in routes) {
        str += `${route} - ${routes[route]}\n`;
    }

    return str;
}

const routerOutputSchema = z.object({
    route: z.enum(allowedRoutes).describe('The route'),
    urls: z.array(z.string()).describe('URLs extracted from the task, feel free to leave empty if there are none'),
});

/**
 * Detect type of user's task, so you can route it to the correct subagent.
 *
 * @param task User's prompt.
 * @returns The route and URLs.
 */
export async function detectType(task: string) {
    Logger.log(`Routing items`, 'Agent');
    const llm = new ChatOpenAI({
        model: process.env.OPENAI_MODEL || 'gpt-4.1',
        temperature: 0.0,
    });

    const prompt = HumanMessagePromptTemplate.fromTemplate(ROUTER_PROMPT);
    const result = await prompt
        .pipe(llm.withStructuredOutput(routerOutputSchema))
        .invoke({ task });

    Logger.log(`Got route "${result.route}" with ${result.urls.length} URLs`, 'Agent');
    return result;
}

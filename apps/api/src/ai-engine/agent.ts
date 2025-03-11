import { Injectable, Logger } from "@nestjs/common";
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { SearchWebTool } from "./tools";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { randomUUID } from "crypto";
import { format } from 'date-fns';

@Injectable()
export class Agent {
    private readonly logger = new Logger(Agent.name);

    private createAgent() {
        this.logger.log('Creating agent');
        const llm = this.getLLM();
        const checkpointer = new MemorySaver();
        const tools = [SearchWebTool];
        const day = format(new Date(), 'cccc');
        const datetime = format(new Date(), 'yyyy-MM-dd HH:mm');

        const prompt = `You are an expert in building directories websites. User may ask you about list of known software, tools, services, places etc
        Today is ${day} the ${datetime}.`;

        const agent = createReactAgent({
            llm,
            checkpointer,
            tools,
            prompt: new SystemMessage({ content: prompt }),
            name: 'directory_generator',
            responseFormat: z.object({
                items: z.array(z.object({
                    name: z.string(),
                    source_url: z.string().describe('The URL of item`s official website/repository'),
                    description: z.string(),
                })),
            }),
        });

        return agent;
    }

    public async invoke(message: string) {
        this.logger.log('Invoking agent with message: "' + message + '"');
        const agent = this.createAgent();
        const result = await agent.invoke(
            { messages: [new HumanMessage(message)] },
            { configurable: { thread_id: randomUUID() } }
        );

        return result.structuredResponse;
    }

    private getLLM() {
        const llm = new ChatOpenAI({
            model: 'gpt-4o-mini',
            temperature: 0.2,
        });

        return llm;
    }
}

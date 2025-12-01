import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { formatDate } from 'date-fns';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { AiService, BaseChatModel, ModelRouterService, TaskComplexity } from 'src/ai';

@Injectable()
export class SearchQueryGenerationService {
    private readonly logger = new Logger(SearchQueryGenerationService.name);
    private llm: BaseChatModel;

    constructor(
        private readonly modelRouter: ModelRouterService,
        private readonly aiService: AiService,
    ) {
        this.llm = this.modelRouter.getModel(TaskComplexity.SIMPLE);
    }

    async generateSearchQueries(
        createItemsGeneratorDto: CreateItemsGeneratorDto,
    ): Promise<string[]> {
        const {
            name,
            prompt: description,
            target_keywords: targetKeywords,
            config,
        } = createItemsGeneratorDto;

        this.logger.log(`[${name}] Generating search queries using LLM...`);

        if (!this.aiService.isAiConfigured()) {
            this.logger.warn(
                `[${name}] OpenAI API Key not configured. Falling back to basic query generation.`,
            );
            const fallbackQueries = [
                `best tools for ${name}`,
                `${name} resources`,
                `${name} libraries`,
                `${name} tutorials`,
                `official documentation ${name}`,
                `community ${name}`,
            ];
            if (targetKeywords && targetKeywords.length > 0) {
                return [
                    ...new Set([
                        ...targetKeywords.map((kw) => `${kw} ${name}`),
                        ...fallbackQueries,
                    ]),
                ].slice(0, config.max_search_queries);
            }
            return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
        }

        const promptTemplate = HumanMessagePromptTemplate.fromTemplate(
            `You are a directory website builder, and your task is to generate search queries that will help you find relevant information on the web, based on the given details.
<details>
- The topic is: "{name}"
- Description: "{description}"
- Optional initial keywords: {target_keywords_string}
- Today is {day} the {datetime}
</details>


<instructions>
- Generate {num_queries} distinct search queries. Each query should be on a new line.  
- Use terms that will help find official resources related to the topic.
- If the task description prioritizes specific items or types of items, don't simply generate queries for those items. Instead, create queries designed to help locate official resources related to the topic.
- Include variations, long-tail keywords, and queries targeting different aspects of the topic.
</instructions>
`,
        );

        const now = new Date();
        const queryGenerationChain = promptTemplate.pipe(this.llm).pipe(new StringOutputParser());

        try {
            const result = await queryGenerationChain.invoke({
                name,
                description,
                target_keywords_string: targetKeywords ? targetKeywords.join(', ') : 'N/A',
                num_queries: config.max_search_queries * 2,
                day: formatDate(now, 'cccc'),
                datetime: formatDate(now, 'yyyy-MM-dd HH:mm'),
            });

            const queries = result
                .split('\n')
                .map((q) => q.trim().replace(/^- /, ''))
                .filter((q) => q.length > 3) // Filter out very short or empty lines
                .filter((q, index, self) => self.indexOf(q) === index); // Ensure uniqueness

            this.logger.log(`[${name}] LLM generated ${queries.length} unique queries.`);
            return queries.slice(0, config.max_search_queries);
        } catch (error) {
            this.logger.error(
                `[${name}] Error generating search queries with LLM: ${error.message}`,
                error.stack,
            );
            this.logger.warn(`[${name}] Falling back to basic query generation due to LLM error.`);
            // Fallback to simpler generation if LLM fails
            const fallbackQueries = [
                `best tools for ${name}`,
                `${name} resources`,
                `${name} libraries`,
                `${name} tutorials`,
                `official documentation ${name}`,
                `community ${name}`,
            ];
            if (targetKeywords && targetKeywords.length > 0) {
                return [
                    ...new Set([
                        ...targetKeywords.map((kw) => `${kw} ${name}`),
                        ...fallbackQueries,
                    ]),
                ].slice(0, config.max_search_queries);
            }
            return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
        }
    }
}

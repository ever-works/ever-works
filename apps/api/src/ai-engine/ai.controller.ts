import { Body, Controller, Post } from "@nestjs/common";
import { Agent } from "./agent";

@Controller()
export class AiController {
    constructor(private readonly agent: Agent) {}

    @Post('ai')
    async invoke(@Body() body: { message: string }) {
        const response = await this.agent.invoke(body.message);
        return response;
    }
}

import { FunctionDefinition } from "openai/resources";
import { AppChatCompletionTool } from "./CommonToolFactory";

export class AgentChatCompletionToolInvocation  {
    constructor(
        public readonly tool: AppChatCompletionTool,
        public readonly args: any,
        private readonly ctx: any = {}
    ) {}
    public get function(): FunctionDefinition {
        return this.tool.function;
    }
    public async finalise(): Promise<any> {
        return this.tool.finalise?.(this.ctx);
    }
    public async invoke(): Promise<any> {
        return this.tool.impl(this.args, this.ctx);
    }
}
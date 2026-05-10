import {
    ChatCompletionFunctionTool,
    ChatCompletionMessage,
    ChatCompletionMessageFunctionToolCall,
    ChatCompletionMessageToolCall,
    ChatCompletionTool,
} from "openai/resources";
import { AgentChatCompletionToolInvocation } from "./ChatCompletionToolInvocation.js";

export interface ToolCallsHandler {
    tools: ChatCompletionTool[];
    handleToolCalls: (chatCompletionMessage: ChatCompletionMessage) => Promise<ToolCallsResponse>;
    promptInjection?: () => string;
    finalise?: () => void;
    id: string;
}

/**
 * A function tool for the chat completion API plus the runtime handler and optional prompt text.
 * Customer-defined tools and built-in channel tools share this shape.
 */
export type AppChatCompletionTool = ChatCompletionFunctionTool & {
    impl: (args: any, ctx: any) => Promise<any>;
    promptInjection?: string;
    finalise: (ctx: any) => Promise<any>;
};

function toOpenAiTool(def: AppChatCompletionTool): ChatCompletionTool {
    return { type: "function", function: def.function };
}

export type ToolCallsResponse = {
    result?: Array<{ role: "tool"; content: string; tool_call_id: string }>;
    error?: string;
    finaliser: () => Promise<void>;
};


/**
 * Base factory for agent tools. Holds shared tool definitions and tool-call handling.
 * Extended by channel-specific factories (e.g. ChatToolFactory, WhatsAppToolFactory).
 */
export class CommonToolFactory {
    public toolByName = new Map<string, AppChatCompletionTool>();
    public commonTools: ChatCompletionTool[] = [];
    public commonPromptInjection: string = "";

    public runningTools: Map<string, ToolCallsHandler> = new Map();

    constructor(
        tools: AppChatCompletionTool[],
    ) {
        for (const def of tools) {
            this.toolByName.set(def.function.name, def);
            this.commonTools.push(toOpenAiTool(def));
        }
    }

    public toolCallFinished(id: string) {
        const tool = this.runningTools.get(id);
        if (tool) {
            tool.finalise?.();
            this.runningTools.delete(id);
        }
    }

    public addRunningTool(tool: ToolCallsHandler) {
        this.runningTools.set(tool.id, tool);
    }


    public isFunctionToolCall(toolCall: ChatCompletionMessageToolCall): boolean {
        return toolCall.type === "function";
    }

    public async handleToolCalls(
        chatCompletionMessage: ChatCompletionMessage,
    ): Promise<ToolCallsResponse> {
        let finaliser: () => Promise<void> = async () => {};
        if (!chatCompletionMessage?.tool_calls) {
            return { result: [], finaliser };
        }
        const responses: Array<{ role: "tool"; content: string; tool_call_id: string }> = [];
        const toolInvocations: Array<AgentChatCompletionToolInvocation> = [];

        for (const toolCall of chatCompletionMessage.tool_calls) {
            if (!this.isFunctionToolCall(toolCall)) {
                continue;
            }
            const functionToolCall = toolCall as ChatCompletionMessageFunctionToolCall;
            const name = functionToolCall.function.name;
            const rawArgs = functionToolCall.function.arguments;
            const tool = this.toolByName.get(name);
            if (!tool) {
                return { error: `Tool not found: ${name}`, finaliser };
            }
           
            let args: any = {};
            try {
                args = rawArgs ? JSON.parse(rawArgs) : {};
            } catch (e) {
                return { error: `Invalid JSON arguments: ${e}`, finaliser };
            }
            const toolInvocation = new AgentChatCompletionToolInvocation(tool, args);
            let response: any = {};
            try {
                
                response = await toolInvocation.invoke();
                responses.push({
                    role: "tool",
                    content: JSON.stringify(response),
                    tool_call_id: functionToolCall.id,
                });
            } catch (e: any) {
                return { error: `Execution error: ${e?.message ?? String(e)}`, finaliser };
            } finally {
                toolInvocations.push(toolInvocation);
            }
        }
        const finalisers = toolInvocations.map(toolInvocation => {
            return async () => {
            try {
                await toolInvocation.finalise();   
            } catch (e: any) {
                console.error(`Finalisation error: ${e?.message ?? String(e)}`);
            }
        }});
        finaliser = async () => {
            for (const finaliser of finalisers) {
                await finaliser();
            }
        };
       
        return { result: responses, finaliser };
    }
}

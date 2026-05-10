import { AgentChatCompletionToolInvocation } from "./ChatCompletionToolInvocation.js";
function toOpenAiTool(def) {
    return { type: "function", function: def.function };
}
/**
 * Base factory for agent tools. Holds shared tool definitions and tool-call handling.
 * Extended by channel-specific factories (e.g. ChatToolFactory, WhatsAppToolFactory).
 */
export class CommonToolFactory {
    toolByName = new Map();
    commonTools = [];
    commonPromptInjection = "";
    runningTools = new Map();
    constructor(tools) {
        for (const def of tools) {
            this.toolByName.set(def.function.name, def);
            this.commonTools.push(toOpenAiTool(def));
        }
    }
    toolCallFinished(id) {
        const tool = this.runningTools.get(id);
        if (tool) {
            tool.finalise?.();
            this.runningTools.delete(id);
        }
    }
    addRunningTool(tool) {
        this.runningTools.set(tool.id, tool);
    }
    isFunctionToolCall(toolCall) {
        return toolCall.type === "function";
    }
    async handleToolCalls(chatCompletionMessage) {
        let finaliser = async () => { };
        if (!chatCompletionMessage?.tool_calls) {
            return { result: [], finaliser };
        }
        const responses = [];
        const toolInvocations = [];
        for (const toolCall of chatCompletionMessage.tool_calls) {
            if (!this.isFunctionToolCall(toolCall)) {
                continue;
            }
            const functionToolCall = toolCall;
            const name = functionToolCall.function.name;
            const rawArgs = functionToolCall.function.arguments;
            const tool = this.toolByName.get(name);
            if (!tool) {
                return { error: `Tool not found: ${name}`, finaliser };
            }
            let args = {};
            try {
                args = rawArgs ? JSON.parse(rawArgs) : {};
            }
            catch (e) {
                return { error: `Invalid JSON arguments: ${e}`, finaliser };
            }
            const toolInvocation = new AgentChatCompletionToolInvocation(tool, args);
            let response = {};
            try {
                response = await toolInvocation.invoke();
                responses.push({
                    role: "tool",
                    content: JSON.stringify(response),
                    tool_call_id: functionToolCall.id,
                });
            }
            catch (e) {
                return { error: `Execution error: ${e?.message ?? String(e)}`, finaliser };
            }
            finally {
                toolInvocations.push(toolInvocation);
            }
        }
        const finalisers = toolInvocations.map(toolInvocation => {
            return async () => {
                try {
                    await toolInvocation.finalise();
                }
                catch (e) {
                    console.error(`Finalisation error: ${e?.message ?? String(e)}`);
                }
            };
        });
        finaliser = async () => {
            for (const finaliser of finalisers) {
                await finaliser();
            }
        };
        return { result: responses, finaliser };
    }
}

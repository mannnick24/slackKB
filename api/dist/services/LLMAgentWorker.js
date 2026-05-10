import OpenAI from "openai";
import { config } from "../config.js";
import { EmbeddingService } from "./embedding.service.js";
import { CryptoService } from "./crypto.service.js";
import { CommonToolFactory } from "../plugins/CommonToolFactory.js";
import { createRagPlugin } from "../plugins/RagPlugin.js";
/*
 * Worker to handle LLM interactions for an agent.
 * Uses org-level llmProvider (and apiKey) only.
 */
export class LlmAgentWorker {
    cachedOpenApi = null;
    embeddingService = new EmbeddingService(new CryptoService);
    toolCallsHandler = new CommonToolFactory([createRagPlugin(this.embeddingService, config.defaultOrg)]);
    /** Resolve LLM config from org. Throws if org has no llmProvider. */
    async getLlmConfig() {
        return config.llmConfig;
    }
    async getOpenApi() {
        if (this.cachedOpenApi)
            return this.cachedOpenApi;
        const cfg = await this.getLlmConfig();
        this.cachedOpenApi = new OpenAI({
            apiKey: cfg.apiKey,
            baseURL: cfg.baseUrl,
        });
        return this.cachedOpenApi;
    }
    async getSystemPrompt(options) {
        const systemPropmptFromConfig = config.systemPrompt || "";
        const defaultAgentPrompt = config.defaultAgentPrompt || "";
        let prompt = (systemPropmptFromConfig + " \n" +
            defaultAgentPrompt + " \n");
        if (options?.lastUserMessage) {
            console.log("Getting RAG context");
            const ragContext = await this.embeddingService.getRagContextForPrompt(config.defaultOrg, options.lastUserMessage);
            if (ragContext) {
                prompt = prompt + "\n\n" + ragContext;
            }
        }
        return prompt;
    }
    async completionFromMessages(messages) {
        const lastUserMessage = Array.isArray(messages)
            ? messages.filter((m) => m.role === "user").pop()?.content
            : undefined;
        const systemContent = await this.getSystemPrompt({ lastUserMessage: typeof lastUserMessage === "string" ? lastUserMessage : undefined });
        const llmConfig = await this.getLlmConfig();
        const openapi = await this.getOpenApi();
        const model = llmConfig.model;
        const temperature = llmConfig.temperature ?? 0.2;
        let reply = "";
        try {
            const opts = {
                model,
                messages: [
                    { role: "system", content: systemContent },
                    ...messages,
                ],
                temperature,
            };
            console.log("Creating LLM completion ");
            let response = await openapi.chat.completions.create(opts);
            const toolCallsResponses = [];
            while (response.choices[0].finish_reason === "tool_calls") {
                const messageObject = response.choices[0].message;
                messages.push({
                    role: "assistant",
                    content: messageObject.content ?? null,
                    tool_calls: messageObject.tool_calls,
                });
                const toolCallsResponse = await this.toolCallsHandler?.handleToolCalls(messageObject);
                if (toolCallsResponse.result) {
                    messages.push(...toolCallsResponse.result);
                }
                if (toolCallsResponse.error) {
                    console.error("Tool call error:", toolCallsResponse.error);
                    break;
                }
                toolCallsResponses.push(toolCallsResponse);
                response = await openapi.chat.completions.create({
                    model,
                    messages: [
                        { role: "system", content: systemContent },
                        ...messages,
                    ],
                    temperature,
                });
            }
            reply = response.choices[0].message?.content || "";
            const finaliser = async () => {
                for (const toolCallsResponse of toolCallsResponses) {
                    await toolCallsResponse.finaliser();
                }
            };
            return { reply, finaliser };
        }
        catch (error) {
            console.error("LLM completion error:", error);
            const message = error instanceof Error ? error.message : String(error);
            return { reply: "", error: message, finaliser: async () => { } };
        }
    }
    /**
     * Like {@link completionFromMessages} but streams assistant text via {@link StreamCompletionFromMessagesOptions.onTextDelta}.
     * Tool rounds use the same handler as the non-streaming path; only the chat completion request uses streaming.
     */
    async streamCompletionFromMessages(messages, options = {}) {
        const { onTextDelta } = options;
        const lastUserMessage = Array.isArray(messages)
            ? messages.filter((m) => m.role === "user").pop()?.content
            : undefined;
        const systemContent = await this.getSystemPrompt({
            lastUserMessage: typeof lastUserMessage === "string" ? lastUserMessage : undefined,
        });
        const llmConfig = await this.getLlmConfig();
        const openapi = await this.getOpenApi();
        const model = llmConfig.model;
        const temperature = llmConfig.temperature ?? 0.2;
        const tools = this.toolCallsHandler?.commonTools;
        let reply = "";
        try {
            const toolCallsResponses = [];
            for (;;) {
                const streamParams = {
                    model,
                    messages: [{ role: "system", content: systemContent }, ...messages],
                    temperature,
                };
                if (tools?.length) {
                    streamParams.tools = tools;
                }
                console.log("Creating LLM stream for:");
                const stream = openapi.chat.completions.stream(streamParams);
                if (onTextDelta) {
                    stream.on("content", (delta) => {
                        onTextDelta(delta);
                    });
                }
                const completion = await stream.finalChatCompletion();
                const choice = completion.choices[0];
                const finishReason = choice?.finish_reason;
                if (finishReason === "tool_calls" && choice?.message?.tool_calls?.length) {
                    const messageObject = choice.message;
                    messages.push({
                        role: "assistant",
                        content: messageObject.content ?? null,
                        tool_calls: messageObject.tool_calls,
                    });
                    const toolCallsResponse = await this.toolCallsHandler?.handleToolCalls(messageObject);
                    if (toolCallsResponse?.result?.length) {
                        messages.push(...toolCallsResponse.result);
                    }
                    if (toolCallsResponse?.error) {
                        console.error("Tool call error:", toolCallsResponse.error);
                        break;
                    }
                    if (toolCallsResponse) {
                        toolCallsResponses.push(toolCallsResponse);
                    }
                    continue;
                }
                reply = choice?.message?.content ?? "";
                break;
            }
            const finaliser = async () => {
                for (const toolCallsResponse of toolCallsResponses) {
                    await toolCallsResponse.finaliser();
                }
            };
            return { reply, finaliser };
        }
        catch (error) {
            console.error("LLM stream completion error:", error);
            const message = error instanceof Error ? error.message : String(error);
            return { reply: "", error: message, finaliser: async () => { } };
        }
    }
}

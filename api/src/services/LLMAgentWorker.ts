import OpenAI from "openai";
import { config, LlmProvider } from "../config.js";
import { ChatCompletionMessageParam } from "openai/resources";
import type { ChatCompletionStreamParams } from "openai/resources/chat/completions";
import { EmbeddingService } from "./embedding.service.js";
import { CryptoService } from "./crypto.service.js";
import { CommonToolFactory, ToolCallsResponse } from "../plugins/CommonToolFactory.js";
import { createRagPlugin } from "../plugins/RagPlugin.js";
import { logger } from "../logger.js";


export type LlmCompletionResponse = { reply: string; error?: string; finaliser: () => Promise<void> };

/** Options for {@link LlmAgentWorker.streamCompletionFromMessages}. */
export type StreamCompletionFromMessagesOptions = {
    /**
     * Called for each streamed text delta of the assistant message (final pass and any streamed text before tool calls).
     * For WebRTC AI voice, forward deltas to `TelsisWebRtcCall.feedAssistantVoiceDelta` and call
     * `flushAssistantVoice` when the completion promise settles (see `webrtc/piperTtsMedia.ts`).
     */
    onTextDelta?: (delta: string) => void;
};
/*
 * Worker to handle LLM interactions for an agent.
 * Uses org-level llmProvider (and apiKey) only.
 */
export class LlmAgentWorker {
    private cachedOpenApi: OpenAI | null = null;
    private embeddingService = new EmbeddingService(new CryptoService);
    private toolCallsHandler = new CommonToolFactory([createRagPlugin(this.embeddingService, config.defaultOrg)]);

    /** Resolve LLM config from org. Throws if org has no llmProvider. */
    private async getLlmConfig(): Promise<LlmProvider> {
        return config.llmConfig;
    }

    private async getOpenApi(): Promise<OpenAI> {
        if (this.cachedOpenApi) return this.cachedOpenApi;
        const cfg = await this.getLlmConfig();
        this.cachedOpenApi = new OpenAI({
            apiKey: cfg.apiKey,
            baseURL: cfg.baseUrl,
        });
        return this.cachedOpenApi;
    }

    private async getSystemPrompt(options?: { lastUserMessage?: string }): Promise<string> {
        const systemPropmptFromConfig = config.systemPrompt || "";
        const defaultAgentPrompt = config.defaultAgentPrompt || "";
        let prompt = (
            systemPropmptFromConfig + " \n" +
            defaultAgentPrompt + " \n");
        if (options?.lastUserMessage) {
            logger.debug("llm: fetching RAG context");
            const ragContext = await this.embeddingService.getRagContextForPrompt(config.defaultOrg, options.lastUserMessage);
            if (ragContext) {
                prompt = prompt + "\n\n" + ragContext;
            }
        }
        return prompt;
    }

    public async completionFromMessages(
        messages: ChatCompletionMessageParam[],
    ): Promise<LlmCompletionResponse> {

        const lastUserMessage = Array.isArray(messages)
            ? (messages.filter((m) => m.role === "user") as Array<{ content: string }>).pop()?.content
            : undefined;
        const systemContent = await this.getSystemPrompt({ lastUserMessage: typeof lastUserMessage === "string" ? lastUserMessage : undefined });
        const llmConfig = await this.getLlmConfig();
        const openapi = await this.getOpenApi();
        const model = llmConfig.model;
        const temperature = llmConfig.temperature ?? 0.2;
        let reply = "";
        try {
            const opts: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
                model,
                messages: [
                    { role: "system", content: systemContent },
                    ...messages,
                ],
                temperature,
            };
            logger.debug({ model }, "llm: chat completion");
            let response = await openapi.chat.completions.create(opts);
            const toolCallsResponses: ToolCallsResponse[] = [];

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
                    logger.error({ err: toolCallsResponse.error }, "llm: tool call error");
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
            return {reply, finaliser};
        } catch (error) {
            logger.error({ err: error }, "llm: completion error");
            const message = error instanceof Error ? error.message : String(error);
            return { reply: "", error: message, finaliser: async () => {} };
        }
    }

    /**
     * Like {@link completionFromMessages} but streams assistant text via {@link StreamCompletionFromMessagesOptions.onTextDelta}.
     * Tool rounds use the same handler as the non-streaming path; only the chat completion request uses streaming.
     */
    public async streamCompletionFromMessages(
        messages: ChatCompletionMessageParam[],
        options: StreamCompletionFromMessagesOptions = {},
    ): Promise<LlmCompletionResponse> {
        const { onTextDelta } = options;
        const lastUserMessage = Array.isArray(messages)
            ? (messages.filter((m) => m.role === "user") as Array<{ content: string }>).pop()?.content
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
            const toolCallsResponses: ToolCallsResponse[] = [];

            for (;;) {
                const streamParams: ChatCompletionStreamParams = {
                    model,
                    messages: [{ role: "system", content: systemContent }, ...messages],
                    temperature,
                };
                if (tools?.length) {
                    streamParams.tools = tools;
                }

                logger.debug({ model }, "llm: stream completion");
                const stream = openapi.chat.completions.stream(streamParams);
                if (onTextDelta) {
                    stream.on("content", (delta: string) => {
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
                    const toolCallsResponse =
                        await this.toolCallsHandler?.handleToolCalls(messageObject);
                    if (toolCallsResponse?.result?.length) {
                        messages.push(...toolCallsResponse.result);
                    }
                    if (toolCallsResponse?.error) {
                        logger.error({ err: toolCallsResponse.error }, "llm: tool call error");
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
        } catch (error) {
            logger.error({ err: error }, "llm: stream completion error");
            const message = error instanceof Error ? error.message : String(error);
            return { reply: "", error: message, finaliser: async () => {} };
        }
    }
}
import { randomUUID } from "node:crypto";
import { ReadableStream } from "node:stream/web";

import {
  CursorClient,
  type ChatMessage,
  type ChatRequest,
  type StreamChunk,
} from "./cursor-client";

// Simple alias map to translate common OpenAI model identifiers to Cursor equivalents.
const MODEL_ALIASES: Record<string, string> = {
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4": "gpt-4o", // fallback to 4o if older name is provided
  "gpt-3.5-turbo": "gpt-4o-mini", // lightweight fallback
};

function resolveModelName(model: unknown): string {
  if (typeof model !== "string" || !model) {
    return "gpt-4o";
  }
  return MODEL_ALIASES[model] ?? model;
}

/**
 * Detects OpenAI-style chat completion requests.
 */
export function isOpenAIChatCompletionsRequest(input: string | Request | URL): input is string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  return /\/v1\/chat\/completions/.test(url);
}

/**
 * Extracts textual content from an OpenAI message content payload.
 * Supports both string and array-of-blocks formats; non-text blocks are ignored.
 */
function normalizeOpenAIContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string"
        ) {
          return (part as Record<string, unknown>).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

/**
 * Converts an OpenAI chat request body into the Cursor ChatRequest shape.
 */
function mapOpenAIRequestToCursor(body: any): { request: ChatRequest | null; unsupported: boolean } {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return { request: null, unsupported: false };
  }

  const messages: ChatMessage[] = [];
  let systemMessage: ChatMessage | undefined;
  let unsupported = false;

  for (const message of body.messages as any[]) {
    if (!message || typeof message !== "object" || typeof message.role !== "string") {
      continue;
    }

    // Tool/function calls are not supported yet; surface a clear error.
    if ("tool_calls" in message || "function_call" in message) {
      unsupported = true;
      continue;
    }

    const content = normalizeOpenAIContent(message.content);
    if (!content) {
      continue;
    }

    if (message.role === "system" && !systemMessage) {
      systemMessage = { role: "system", content };
    } else if (message.role === "assistant" || message.role === "user") {
      messages.push({ role: message.role, content });
    }
  }

  if (systemMessage) {
    messages.unshift(systemMessage);
  }

  return {
    request: {
      model: resolveModelName(body.model),
      messages,
      stream: !!body.stream,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    },
    unsupported,
  };
}

/**
 * Formats a Cursor stream chunk as an OpenAI SSE data line.
 */
function formatSseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Wraps Cursor streaming output as OpenAI-compatible SSE.
 */
async function streamCursorAsOpenAI(
  client: CursorClient,
  chatRequest: ChatRequest
): Promise<Response> {
  const encoder = new TextEncoder();
  const streamId = randomUUID();
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const chunkStream = (async function* () {
          try {
            for await (const chunk of client.unifiedChatStream(chatRequest)) {
              yield chunk;
            }
            return;
          } catch (error) {
            console.warn("Unified chat stream failed, falling back to legacy:", error);
          }
          for await (const chunk of client.chatStream(chatRequest)) {
            yield chunk;
          }
        })();

        for await (const chunk of chunkStream) {
          if (chunk.type === "delta" && chunk.content) {
            const payload = {
              id: `cursor-${streamId}`,
              object: "chat.completion.chunk",
              created,
              model: chatRequest.model,
              choices: [
                {
                  index: 0,
                  delta: { content: chunk.content },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(formatSseChunk(payload)));
          } else if (chunk.type === "error") {
            const payload = {
              error: {
                message: chunk.error ?? "Unknown Cursor streaming error",
                type: "cursor_error",
              },
            };
            controller.enqueue(encoder.encode(formatSseChunk(payload)));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
        }

        const donePayload = {
          id: `cursor-${streamId}`,
          object: "chat.completion.chunk",
          created,
          model: chatRequest.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        controller.enqueue(encoder.encode(formatSseChunk(donePayload)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Handles OpenAI-compatible chat completion requests by routing them to Cursor.
 * Returns a Response when the request is handled; otherwise returns null.
 */
export async function handleOpenAIChatCompletions(
  input: string | Request | URL,
  init: RequestInit | undefined,
  client: CursorClient
): Promise<Response | null> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (!isOpenAIChatCompletionsRequest(url)) {
    return null;
  }

  if (!init || !init.body) {
    return null;
  }

  let bodyText: string | null = null;

  if (typeof init.body === "string") {
    bodyText = init.body;
  } else if (init.body instanceof Uint8Array) {
    bodyText = Buffer.from(init.body).toString("utf8");
  } else if (init.body instanceof ArrayBuffer) {
    bodyText = Buffer.from(init.body).toString("utf8");
  }

  if (bodyText === null) {
    return null;
  }

  let parsedBody: any;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return null;
  }

  const { request: chatRequest, unsupported } = mapOpenAIRequestToCursor(parsedBody);

  if (unsupported) {
    const errorBody = {
      error: {
        message: "tool_calls/function_call are not supported by the Cursor OpenAI shim yet.",
        type: "unsupported_operation",
      },
    };
    return new Response(JSON.stringify(errorBody), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!chatRequest) {
    return null;
  }

  try {
    if (chatRequest.stream) {
      return await streamCursorAsOpenAI(client, chatRequest);
    }

    let content: string;
    try {
      content = await client.unifiedChat(chatRequest);
    } catch (error) {
      console.warn("Unified chat request failed, falling back to legacy:", error);
      content = await client.chat(chatRequest);
    }
    const responsePayload = {
      id: `cursor-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: chatRequest.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
    const errorBody = {
      error: {
        message,
        type: "cursor_error",
      },
    };
    return new Response(JSON.stringify(errorBody), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

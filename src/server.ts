/**
 * OpenAI-Compatible API Server
 * 
 * Routes OpenAI API requests through Cursor's Agent API backend.
 * Supports:
 * - POST /v1/chat/completions (streaming and non-streaming)
 * - GET /v1/models
 * 
 * Usage:
 *   CURSOR_ACCESS_TOKEN=<token> bun run src/server.ts
 *   
 * Or with auto-loaded credentials:
 *   bun run src/server.ts
 */

import { createAgentServiceClient, AgentMode, type OpenAIToolDefinition, type ExecRequest, type McpExecRequest, type AgentStreamChunk } from "./lib/api/agent-service";
import { FileCredentialManager } from "./lib/storage";
import {
  cleanupExpiredSessions,
  collectToolMessages,
  createSessionId,
  findSessionIdInMessages,
  makeToolCallId,
  mapExecRequestToTool,
  selectCallBase,
  sendToolResultsToCursor,
  type SessionLike,
} from "./lib/session-reuse";

// --- Constants ---

const API_BASE = "https://api2.cursor.sh";

// --- Types ---

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// --- Session Management for Cursor stream reuse ---
interface CursorSession extends SessionLike {
  client: ReturnType<typeof createAgentServiceClient>;
  iterator: AsyncIterator<AgentStreamChunk>;
  pendingExecs: Map<string, ExecRequest>;
  model: string;
  completionId: string;
}

const cursorSessions = new Map<string, CursorSession>();
const toolCallToSession = new Map<string, string>();
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes idle timeout
const HEARTBEAT_IDLE_LIMIT = 30; // fall back to close after too many idle heartbeats

function mapToolCallToSession(toolCallId: string, sessionId: string) {
  toolCallToSession.set(toolCallId, sessionId);
}

function unmapToolCall(toolCallId: string) {
  toolCallToSession.delete(toolCallId);
}

function clearSessionToolMappings(sessionId: string) {
  for (const [tcId, sid] of toolCallToSession) {
    if (sid === sessionId) {
      toolCallToSession.delete(tcId);
    }
  }
}

interface OpenAIMessage {

  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

interface ToolResultRequestBody {
  tool_call_id: string;
  content?: string;
  is_error?: boolean;
  error?: string;
}


interface OpenAIChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: OpenAIStreamToolCallDelta[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
}

interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

// --- Model Details (from Cursor API) ---

interface CursorModelDetails {
  modelId: string;
  displayModelId: string;
  displayName: string;
  displayNameShort: string;
  aliases: string[];
  maxMode?: boolean;
}

// Cache for fetched models
let cachedModels: CursorModelDetails[] | null = null;
let modelsCacheTime = 0;
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Pending tool results keyed by OpenAI tool_call_id
interface PendingToolResult {
  execRequest: ExecRequest;  // Can be any exec request type now
  client: ReturnType<typeof createAgentServiceClient>;
  resolve?: (result: { content?: string; error?: string }) => void;
}
const pendingToolResults = new Map<string, PendingToolResult>();

// --- Proto Parsing Helpers ---

function decodeVarint(bytes: Uint8Array, offset: number): { value: number; newOffset: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  
  while (pos < bytes.length) {
    const byte = bytes[pos]!;
    value |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  
  return { value, newOffset: pos };
}

function decodeString(bytes: Uint8Array, offset: number): { value: string; newOffset: number } {
  const { value: length, newOffset: dataStart } = decodeVarint(bytes, offset);
  const value = new TextDecoder().decode(bytes.slice(dataStart, dataStart + length));
  return { value, newOffset: dataStart + length };
}

function parseModelDetails(bytes: Uint8Array, start: number, end: number): CursorModelDetails {
  const model: CursorModelDetails = {
    modelId: "",
    displayModelId: "",
    displayName: "",
    displayNameShort: "",
    aliases: [],
  };
  
  let pos = start;
  while (pos < end) {
    const { value: tag, newOffset: afterTag } = decodeVarint(bytes, pos);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    pos = afterTag;
    
    if (wireType === 2) { // Length-delimited
      const { value: str, newOffset } = decodeString(bytes, pos);
      pos = newOffset;
      
      switch (fieldNumber) {
        case 1: model.modelId = str; break;
        case 3: model.displayModelId = str; break;
        case 4: model.displayName = str; break;
        case 5: model.displayNameShort = str; break;
        case 6: model.aliases.push(str); break;
      }
    } else if (wireType === 0) { // Varint
      const { value, newOffset } = decodeVarint(bytes, pos);
      pos = newOffset;
      
      if (fieldNumber === 7) {
        model.maxMode = value === 1;
      }
    }
  }
  
  return model;
}

function parseGetUsableModelsResponse(bytes: Uint8Array): CursorModelDetails[] {
  const models: CursorModelDetails[] = [];
  let pos = 0;
  
  while (pos < bytes.length) {
    const { value: tag, newOffset: afterTag } = decodeVarint(bytes, pos);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    pos = afterTag;
    
    if (fieldNumber === 1 && wireType === 2) {
      const { value: length, newOffset: dataStart } = decodeVarint(bytes, pos);
      const model = parseModelDetails(bytes, dataStart, dataStart + length);
      models.push(model);
      pos = dataStart + length;
    } else if (wireType === 2) {
      const { value: length, newOffset } = decodeVarint(bytes, pos);
      pos = newOffset + length;
    } else if (wireType === 0) {
      const { newOffset } = decodeVarint(bytes, pos);
      pos = newOffset;
    }
  }
  
  return models;
}

// --- Model Fetching ---

async function fetchUsableModels(accessToken: string): Promise<CursorModelDetails[]> {
  // Check cache
  if (cachedModels && Date.now() - modelsCacheTime < MODEL_CACHE_TTL) {
    return cachedModels;
  }
  
  // GetUsableModelsRequest is empty
  const requestBody = new Uint8Array([]);
  
  // Add gRPC-Web frame
  const framedBody = new Uint8Array(5 + requestBody.length);
  framedBody[0] = 0; // compression flag
  const len = requestBody.length;
  framedBody[1] = (len >> 24) & 0xff;
  framedBody[2] = (len >> 16) & 0xff;
  framedBody[3] = (len >> 8) & 0xff;
  framedBody[4] = len & 0xff;
  framedBody.set(requestBody, 5);
  
  const url = `${API_BASE}/aiserver.v1.AiService/GetUsableModels`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "Authorization": `Bearer ${accessToken}`,
      "x-cursor-client-version": "cli-2025.11.25-d5b3271",
      "x-ghost-mode": "false",
      "x-request-id": crypto.randomUUID(),
    },
    body: framedBody,
  });
  
  if (!response.ok) {
    throw new Error(`GetUsableModels failed: ${response.status}`);
  }
  
  const responseBuffer = await response.arrayBuffer();
  const responseBytes = new Uint8Array(responseBuffer);
  
  if (responseBytes.length < 5) {
    throw new Error("Response too short");
  }
  
  const compressionFlag = responseBytes[0];
  const messageLength = (responseBytes[1]! << 24) | (responseBytes[2]! << 16) | (responseBytes[3]! << 8) | responseBytes[4]!;
  
  if (compressionFlag !== 0) {
    throw new Error("Compressed responses not supported");
  }
  
  const messageData = responseBytes.slice(5, 5 + messageLength);
  const models = parseGetUsableModelsResponse(messageData);
  
  // Update cache
  cachedModels = models;
  modelsCacheTime = Date.now();
  
  return models;
}

function cursorModelToOpenAI(model: CursorModelDetails): OpenAIModel {
  // Determine owner based on model name
  let owned_by = "cursor";
  const lowerName = model.displayName.toLowerCase();
  if (lowerName.includes("claude") || lowerName.includes("opus") || lowerName.includes("sonnet")) {
    owned_by = "anthropic";
  } else if (lowerName.includes("gpt")) {
    owned_by = "openai";
  } else if (lowerName.includes("gemini")) {
    owned_by = "google";
  } else if (lowerName.includes("grok")) {
    owned_by = "xai";
  }
  
  return {
    id: model.displayModelId || model.modelId,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by,
  };
}

function resolveModel(requestedModel: string, models: CursorModelDetails[]): string {
  // First, check direct match on displayModelId or modelId
  const directMatch = models.find(m => 
    m.displayModelId === requestedModel || 
    m.modelId === requestedModel
  );
  if (directMatch) {
    return directMatch.modelId;
  }
  
  // Check aliases
  const aliasMatch = models.find(m => m.aliases.includes(requestedModel));
  if (aliasMatch) {
    return aliasMatch.modelId;
  }
  
  // No match found, use as-is (let Cursor API handle it)
  return requestedModel;
}

// --- Helpers ---

function generateId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Convert OpenAI messages array to a prompt string for Cursor.
 * Handles the full message history including:
 * - system messages (prepended)
 * - user messages
 * - assistant messages (including those with tool_calls)
 * - tool result messages (role: "tool")
 * 
 * For multi-turn conversations with tool calls, this formats the conversation
 * so the model can see what tools were called and their results.
 */
function messagesToPrompt(messages: OpenAIMessage[]): string {
  const parts: string[] = [];
  
  // Extract system messages to prepend
  const systemMessages = messages.filter(m => m.role === "system");
  if (systemMessages.length > 0) {
    parts.push(systemMessages.map(m => m.content ?? "").join("\n"));
  }
  
  // Process non-system messages in order
  const conversationMessages = messages.filter(m => m.role !== "system");
  
  // Check if this is a continuation with tool results
  const hasToolResults = conversationMessages.some(m => m.role === "tool");
  
  if (hasToolResults) {
    // Multi-turn with tool results - format the full conversation
    for (const msg of conversationMessages) {
      if (msg.role === "user") {
        parts.push(`User: ${msg.content ?? ""}`);
      } else if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant made tool calls - show what was called
          const toolCallsDesc = msg.tool_calls.map(tc => 
            `[Called tool: ${tc.function.name}(${tc.function.arguments})]`
          ).join("\n");
          if (msg.content) {
            parts.push(`Assistant: ${msg.content}\n${toolCallsDesc}`);
          } else {
            parts.push(`Assistant: ${toolCallsDesc}`);
          }
        } else if (msg.content) {
          parts.push(`Assistant: ${msg.content}`);
        }
      } else if (msg.role === "tool") {
        // Tool result - show the result with the tool call ID for context
        parts.push(`[Tool result for ${msg.tool_call_id}]: ${msg.content ?? ""}`);
      }
    }
    
    // Add instruction for the model to continue
    parts.push("\nBased on the tool results above, please continue your response:");
  } else {
    // Simple case - just use the last user message (original behavior)
    const userMessages = conversationMessages.filter(m => m.role === "user");
    if (userMessages.length > 0) {
      const lastUserMsg = userMessages[userMessages.length - 1];
      parts.push(lastUserMsg?.content ?? "");
    }
  }
  
  return parts.join("\n\n");
}

function createErrorResponse(message: string, type: string = "invalid_request_error", status: number = 400): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// --- SSE Streaming ---

function createSSEChunk(chunk: OpenAIStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createSSEDone(): string {
  return "data: [DONE]\n\n";
}

function makeStreamResponse(readable: ReadableStream<Uint8Array>): Response {
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function streamCursorSession(
  session: CursorSession,
  model: string,
  completionId: string,
  _isContinuation: boolean
): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Emit initial role chunk for every OpenAI stream
      const initialChunk: OpenAIStreamChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      };
      controller.enqueue(encoder.encode(createSSEChunk(initialChunk)));

      try {
        let carryChunk: AgentStreamChunk | null = null;
        while (true) {
          const { value, done } = carryChunk
            ? { value: carryChunk, done: false as const }
            : await session.iterator.next();
          carryChunk = null;
          session.lastActivity = Date.now();

          if (done || !value) {

            const finalChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));
            controller.enqueue(encoder.encode(createSSEDone()));
            clearSessionToolMappings(session.id);
            cursorSessions.delete(session.id);
            controller.close();
            return;
          }


          const chunk = value as AgentStreamChunk;

          if ((chunk.type === "text" || chunk.type === "token") && chunk.content) {
            const streamChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: chunk.content },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(createSSEChunk(streamChunk)));
          } else if (chunk.type === "exec_request" && chunk.execRequest) {
            // Convert exec_request(s) into OpenAI tool_calls and park the Cursor stream.
            const toolCalls: {
              openaiToolCallId: string;
              toolName: string;
              toolArgs: Record<string, any>;
              index: number;
              execReq: ExecRequest;
            }[] = [];

            let currentChunk: AgentStreamChunk | null = chunk;
            while (currentChunk && currentChunk.type === "exec_request" && currentChunk.execRequest) {
              const execReq = currentChunk.execRequest;
              if (execReq.type !== "request_context") {
                const { toolName, toolArgs } = mapExecRequestToTool(execReq);
                if (toolName && toolArgs) {
                  const callBase = selectCallBase(execReq);
                  const openaiToolCallId = makeToolCallId(session.id, callBase);
                  session.pendingExecs.set(openaiToolCallId, execReq);
                  mapToolCallToSession(openaiToolCallId, session.id);
                  toolCalls.push({
                    openaiToolCallId,
                    toolName,
                    toolArgs,
                    index: toolCalls.length,
                    execReq,
                  });
                }
              }

              const next = await session.iterator.next();
              if (next.done || !next.value) {
                currentChunk = null;
                break;
              }
              if ((next.value as AgentStreamChunk).type === "exec_request") {
                currentChunk = next.value as AgentStreamChunk;
              } else {
                carryChunk = next.value as AgentStreamChunk;
                currentChunk = null;
                break;
              }
            }

            if (toolCalls.length === 0) {
              continue;
            }

            session.state = "waiting_tool";
            session.lastActivity = Date.now();

            const toolCallChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: toolCalls.map((tc) => ({
                      index: tc.index,
                      id: tc.openaiToolCallId,
                      type: "function",
                      function: {
                        name: tc.toolName,
                        arguments: JSON.stringify(tc.toolArgs),
                      },
                    })),
                  },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));

            const finishChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "tool_calls",
                },
              ],
            };
            controller.enqueue(encoder.encode(createSSEChunk(finishChunk)));
            controller.enqueue(encoder.encode(createSSEDone()));
            controller.close();
            return;
          } else if (chunk.type === "error") {
            controller.enqueue(
              encoder.encode(
                createSSEChunk({
                  error: { message: chunk.error ?? "Unknown Cursor streaming error", type: "cursor_error" },
                } as any)
              )
            );
            controller.enqueue(encoder.encode(createSSEDone()));
            cursorSessions.delete(session.id);
            controller.close();
            return;
          } else if (chunk.type === "heartbeat" || chunk.type === "checkpoint") {
            continue;
          } else if (chunk.type === "exec_server_abort") {
            // Server sent abort signal for exec - log and continue
            console.log(`[Session ${session.id}] Received exec_server_abort from Cursor`);
            continue;
          } else if (chunk.type === "interaction_query") {
            // Server is asking for user interaction (web search approval, etc.)
            // For now, log it - we may need to auto-approve or handle differently
            console.log(`[Session ${session.id}] Received interaction_query: id=${chunk.queryId}, type=${chunk.queryType}`);
            // TODO: May need to send InteractionResponse back via BidiAppend
            continue;
          } else if (chunk.type === "done") {
            const finalChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));
            controller.enqueue(encoder.encode(createSSEDone()));
            clearSessionToolMappings(session.id);
            cursorSessions.delete(session.id);
            controller.close();
            return;

          }
        }
      } catch (err: any) {
        console.error(`[Session ${session.id}] Stream error:`, err);
        try {
          controller.enqueue(
            encoder.encode(
              createSSEChunk({
                error: { message: err?.message ?? String(err), type: "cursor_error" },
              } as any)
            )
          );
          controller.enqueue(encoder.encode(createSSEDone()));
        } catch {}
        cursorSessions.delete(session.id);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      session.state = "waiting_tool";
    },
  });

  return makeStreamResponse(readable);
}

/**
 * DEPRECATED: Session reuse for tool-calling flows.
 * 
 * This function is currently NOT USED because BidiAppend-based session reuse
 * doesn't work properly for tool results. When tool results are sent via
 * BidiAppend, the model stores its response in KV blobs instead of streaming.
 * 
 * Kept here for future reference if we implement Option B (KV blob extraction).
 * See docs/TOOL_CALLING_INVESTIGATION.md "Session 9" for details.
 * 
 * @deprecated Use legacyStreamResponse instead for all streaming requests
 */
async function streamWithSessionReuse(
  body: OpenAIChatRequest,
  model: string,
  accessToken: string
): Promise<Response> {
  await cleanupExpiredSessions(cursorSessions, SESSION_TIMEOUT_MS);

  const sessionIdFromHistory = findSessionIdInMessages(body.messages ?? []);
  const toolMessages = collectToolMessages(body.messages ?? []);

  if (toolMessages.length > 0) {
    const mappedId = toolMessages
      .map((m) => (m.tool_call_id ? toolCallToSession.get(m.tool_call_id) : null))
      .find((id): id is string => !!id);
    if (mappedId) {
      const mappedSession = cursorSessions.get(mappedId);
      if (mappedSession) {
        const sent = await sendToolResultsToCursor(mappedSession, toolMessages);
        if (sent) {
          toolMessages.forEach((m) => m.tool_call_id && unmapToolCall(m.tool_call_id));
          mappedSession.state = "running";
          mappedSession.lastActivity = Date.now();
          console.log(
            `[SESSION] Resuming via mapping ${mappedSession.id} model=${mappedSession.model ?? model} tools=${toolMessages.length}`
          );
          return streamCursorSession(mappedSession, mappedSession.model ?? model, mappedSession.completionId, true);
        }
        console.warn(`[SESSION] Failed to apply tool results via mapping for session ${mappedSession.id}`);
      }
    }
  }

  if (sessionIdFromHistory) {

    const existing = cursorSessions.get(sessionIdFromHistory);
    if (existing && toolMessages.length > 0) {
      const sent = await sendToolResultsToCursor(existing, toolMessages);
      if (sent) {
        toolMessages.forEach((m) => m.tool_call_id && unmapToolCall(m.tool_call_id));
        if (!existing.completionId) {
          existing.completionId = generateId();
        }
        existing.state = "running";
        existing.lastActivity = Date.now();
        console.log(
          `[SESSION] Resuming session ${existing.id} model=${existing.model ?? model} tools=${toolMessages.length}`
        );
        return streamCursorSession(existing, existing.model ?? model, existing.completionId, true);
      }
      console.warn(`[SESSION] Failed to apply tool results for session ${existing.id}; starting fresh`);
    } else if (!existing) {
      console.warn(`[SESSION] Session ${sessionIdFromHistory} not found; starting new session`);
    } else if (toolMessages.length === 0) {
      console.warn(`[SESSION] No tool messages for session ${sessionIdFromHistory}; starting new session`);
    }
  }

  // Fallback: try mapping from tool_call_id to session
  if (toolMessages.length > 0) {
    const mappedId = toolMessages
      .map((m) => (m.tool_call_id ? toolCallToSession.get(m.tool_call_id) : null))
      .find((id): id is string => !!id);
    if (mappedId) {
      const mappedSession = cursorSessions.get(mappedId);
      if (mappedSession) {
        const sent = await sendToolResultsToCursor(mappedSession, toolMessages);
        if (sent) {
          toolMessages.forEach((m) => m.tool_call_id && unmapToolCall(m.tool_call_id));
          mappedSession.state = "running";
          mappedSession.lastActivity = Date.now();
          console.log(
            `[SESSION] Resuming via mapping ${mappedSession.id} model=${mappedSession.model ?? model} tools=${toolMessages.length}`
          );
          return streamCursorSession(mappedSession, mappedSession.model ?? model, mappedSession.completionId, true);
        }
        console.warn(`[SESSION] Failed to apply tool results via mapping for session ${mappedSession.id}`);
      }
    }
  }

  // New session
  const prompt = messagesToPrompt(body.messages);
  const client = createAgentServiceClient(accessToken);
  const iterator = client.chatStream({
    message: prompt,
    model,
    mode: AgentMode.AGENT,
    tools: body.tools as OpenAIToolDefinition[] | undefined,
  });

  const sessionId = createSessionId();
  const completionId = generateId();
  const session: CursorSession = {
    id: sessionId,
    client,
    iterator,
    pendingExecs: new Map(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    model,
    completionId,
    state: "running",
  };

  cursorSessions.set(sessionId, session);
  console.log(
    `[SESSION] New session ${sessionId} model=${model} tools=${(body.tools as any[] | undefined)?.length ?? 0}`
  );

  return streamCursorSession(session, model, completionId, false);
}

// --- Legacy streaming (non-session) ---

interface LegacyStreamParams {
  body: OpenAIChatRequest;
  model: string;
  prompt: string;
  completionId: string;
  created: number;
  accessToken: string;
}

async function legacyStreamResponse({ body, model, prompt, completionId, created, accessToken }: LegacyStreamParams): Promise<Response> {
  const client = createAgentServiceClient(accessToken);
  const encoder = new TextEncoder();
  let isClosed = false;
  let hasToolCalls = false;
  let toolCallIndex = 0; // For internal Cursor tool calls (built-in)
  let mcpToolCallIndex = 0; // Separate counter for MCP tool calls emitted to OpenAI
  const toolCallIdMap: Map<string, number> = new Map(); // Map Cursor call IDs to OpenAI indices
  let toolExecutionCompleted = false; // Track if we've completed tool execution
  let heartbeatCountAfterExec = 0; // Count heartbeats after tool execution

  const readable = new ReadableStream({
    async start(controller) {
      try {
        // Send initial chunk with role
        const initialChunk: OpenAIStreamChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: body.model ?? "gpt-4o",
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(createSSEChunk(initialChunk)));

        // Stream content
        const tools = body.tools as OpenAIToolDefinition[] | undefined;
        for await (const chunk of client.chatStream({ message: prompt, model, mode: AgentMode.AGENT, tools })) {
          if (isClosed) break;

          if (chunk.type === "text" || chunk.type === "token") {
            if (chunk.content) {
              const streamChunk: OpenAIStreamChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: body.model ?? "gpt-4o",
                choices: [
                  {
                    index: 0,
                    delta: { content: chunk.content },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(createSSEChunk(streamChunk)));
            }
          } else if (chunk.type === "tool_call_started" && chunk.toolCall) {
            // Tool call started - we handle these internally via exec_requests
            console.log(`[DEBUG] Tool call started: ${chunk.toolCall.name} (handled internally)`);
            toolCallIdMap.set(chunk.toolCall.callId, toolCallIndex++);
          } else if (chunk.type === "partial_tool_call" && chunk.toolCall && chunk.partialArgs) {
            console.log(`[DEBUG] Partial tool call for: ${chunk.toolCall.callId}`);
          } else if (chunk.type === "tool_call_completed" && chunk.toolCall) {
            console.log(`[DEBUG] Tool call completed: ${chunk.toolCall.name}`);
          } else if (chunk.type === "exec_request" && chunk.execRequest) {
            const execReq = chunk.execRequest;
            console.log("[DEBUG] Received exec_request:", { type: execReq.type, id: execReq.id });

            const toolsProvided = tools && tools.length > 0;

            if (toolsProvided && execReq.type !== "request_context") {
              hasToolCalls = true;
              const currentIndex = mcpToolCallIndex++;

              let toolName: string;
              let toolArgs: Record<string, any>;

              if (execReq.type === "shell") {
                toolName = "bash";
                toolArgs = { command: execReq.command };
                if (execReq.cwd) toolArgs.cwd = execReq.cwd;
              } else if (execReq.type === "read") {
                toolName = "read";
                toolArgs = { filePath: execReq.path };
              } else if (execReq.type === "ls") {
                toolName = "list";
                toolArgs = { path: execReq.path };
              } else if (execReq.type === "grep") {
                toolName = execReq.glob ? "glob" : "grep";
                toolArgs = execReq.glob
                  ? { pattern: execReq.glob, path: execReq.path }
                  : { pattern: execReq.pattern, path: execReq.path };
              } else if (execReq.type === "mcp") {
                toolName = execReq.toolName;
                toolArgs = execReq.args;
              } else {
                console.log(`[DEBUG] Unknown exec type ${(execReq as any).type}, skipping`);
                continue;
              }

              console.log(`[DEBUG] Emitting tool_call to client: ${toolName}(${JSON.stringify(toolArgs)})`);

              const callIdBase = execReq.type === "mcp" ? execReq.toolCallId : execReq.execId || String(execReq.id);
              const openaiToolCallId = `call_${callIdBase.replace(/-/g, "").slice(0, 24)}`;

              const toolCallChunk: OpenAIStreamChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: body.model ?? "gpt-4o",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: currentIndex,
                          id: openaiToolCallId,
                          type: "function",
                          function: {
                            name: toolName,
                            arguments: JSON.stringify(toolArgs),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));

              const toolCallsFinishChunk: OpenAIStreamChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: body.model ?? "gpt-4o",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "tool_calls",
                  },
                ],
              };
              controller.enqueue(encoder.encode(createSSEChunk(toolCallsFinishChunk)));
              controller.enqueue(encoder.encode(createSSEDone()));

              isClosed = true;
              controller.close();

              console.log("[DEBUG] OpenAI stream closed. Client will send tool results in new request.");
              return;
            } else if (execReq.type === "shell") {
              console.log(`[DEBUG] Executing shell command: ${execReq.command}`);
              const startTime = Date.now();
              const cwd = execReq.cwd || process.cwd();
              try {
                const proc = Bun.spawn(["sh", "-c", execReq.command], { cwd, stdout: "pipe", stderr: "pipe" });
                const stdout = await new Response(proc.stdout).text();
                const stderr = await new Response(proc.stderr).text();
                const exitCode = await proc.exited;
                const executionTimeMs = Date.now() - startTime;
                console.log(`[DEBUG] Shell result (exit=${exitCode}): ${(stdout + stderr).slice(0, 200)}`);

                await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, stdout, stderr, exitCode, executionTimeMs);
                console.log("[DEBUG] Sent shell result");
                toolExecutionCompleted = true;
              } catch (err: any) {
                console.error("[ERROR] Shell execution failed:", err.message);
                const executionTimeMs = Date.now() - startTime;
                await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, "", `Error: ${err.message}`, 1, executionTimeMs);
                toolExecutionCompleted = true;
              }
            } else if (execReq.type === "read") {
              console.log(`[DEBUG] Reading file: ${execReq.path}`);
              try {
                const file = Bun.file(execReq.path);
                const content = await file.text();
                const stats = await file.stat();
                const totalLines = content.split("\n").length;
                await client.sendReadResult(execReq.id, execReq.execId, content, execReq.path, totalLines, BigInt(stats.size), false);
                console.log("[DEBUG] Sent read result");
                toolExecutionCompleted = true;
              } catch (err: any) {
                console.error("[ERROR] Read failed:", err.message);
                await client.sendReadResult(execReq.id, execReq.execId, `Error: ${err.message}`, execReq.path, 0, 0n, false);
                toolExecutionCompleted = true;
              }
            } else if (execReq.type === "ls") {
              console.log(`[DEBUG] Listing directory: ${execReq.path}`);
              try {
                const { readdir } = await import("node:fs/promises");
                const entries = await readdir(execReq.path, { withFileTypes: true });
                const files = entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name).join("\n");
                await client.sendLsResult(execReq.id, execReq.execId, files);
                console.log("[DEBUG] Sent ls result");
                toolExecutionCompleted = true;
              } catch (err: any) {
                console.error("[ERROR] ls failed:", err.message);
                await client.sendLsResult(execReq.id, execReq.execId, `Error: ${err.message}`);
                toolExecutionCompleted = true;
              }
            } else if (execReq.type === "grep") {
              console.log(`[DEBUG] grep/glob request: pattern=${execReq.pattern || execReq.glob}, path=${execReq.path || process.cwd()}`);
              try {
                let files: string[] = [];
                if (execReq.glob) {
                  const globber = new Bun.Glob(execReq.glob);
                  files = Array.from(globber.scanSync(execReq.path || process.cwd()));
                } else if (execReq.pattern) {
                  const rg = Bun.spawn(["rg", "-l", execReq.pattern, execReq.path || process.cwd()], { stdout: "pipe", stderr: "pipe" });
                  const stdout = await new Response(rg.stdout).text();
                  files = stdout.split("\n").filter((f) => f.length > 0);
                }
                await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || execReq.glob || "", execReq.path || process.cwd(), files);
                console.log("[DEBUG] Sent grep result");
                toolExecutionCompleted = true;
              } catch (err: any) {
                console.error("[ERROR] grep/glob failed:", err.message);
                await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || execReq.glob || "", execReq.path || process.cwd(), []);
                toolExecutionCompleted = true;
              }
            } else if (execReq.type === "mcp") {
              console.log(`[DEBUG] MCP exec request: ${execReq.name}`);
              pendingToolResults.set(execReq.toolCallId, { execRequest: execReq, client });
              const toolCallChunk: OpenAIStreamChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: body.model ?? "gpt-4o",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: execReq.toolCallId,
                          type: "function",
                          function: {
                            name: execReq.toolName,
                            arguments: JSON.stringify(execReq.args),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));

              const toolCallsFinishChunk: OpenAIStreamChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: body.model ?? "gpt-4o",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "tool_calls",
                  },
                ],
              };
              controller.enqueue(encoder.encode(createSSEChunk(toolCallsFinishChunk)));
              controller.enqueue(encoder.encode(createSSEDone()));
              isClosed = true;
              controller.close();
              console.log("[DEBUG] OpenAI stream closed for MCP tool. Waiting for tool result...");
              return;
            }
          } else if (chunk.type === "heartbeat") {
            if (toolExecutionCompleted) {
              heartbeatCountAfterExec++;
              // Wait much longer to see if server eventually sends text
              // Native Cursor CLI has no heartbeat limit - it waits indefinitely
              if (heartbeatCountAfterExec >= 300) {  // ~5 minutes at 1 heartbeat/sec
                console.log("[DEBUG] Closing stream after heartbeat threshold post tool execution");
                break;
              }
              if (heartbeatCountAfterExec % 30 === 0) {
                console.log(`[DEBUG] ${heartbeatCountAfterExec} heartbeats since tool execution, still waiting...`);
              }
            }
          } else if (chunk.type === "checkpoint") {
            continue;
          } else if (chunk.type === "exec_server_abort") {
            console.log("[DEBUG] Received exec_server_abort from Cursor");
            continue;
          } else if (chunk.type === "interaction_query") {
            console.log(`[DEBUG] Received interaction_query: id=${chunk.queryId}, type=${chunk.queryType}`);
            continue;
          } else if (chunk.type === "done") {
            break;
          } else if (chunk.type === "error") {
            console.error("Cursor stream error:", chunk.error);
            const errorChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: body.model ?? "gpt-4o",
              choices: [
                {
                  index: 0,
                  delta: { content: chunk.error ?? "Unknown error" },
                  finish_reason: "stop",
                },
              ],
            };
            controller.enqueue(encoder.encode(createSSEChunk(errorChunk)));
            break;
          }
        }

        // Send final chunk
        if (!isClosed) {
          const finalChunk: OpenAIStreamChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: body.model ?? "gpt-4o",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: hasToolCalls ? "tool_calls" : "stop",
              },
            ],
          };
          controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));

          // Send done signal
          controller.enqueue(encoder.encode(createSSEDone()));
          isClosed = true;
          controller.close();
        }
      } catch (err: any) {
        console.error("Stream error:", err);
        if (!isClosed) {
          isClosed = true;
          try {
            controller.error(err);
          } catch {
            // Controller may already be in error state
          }
        }
      }
    },
    cancel() {
      isClosed = true;
    },
  });

  return makeStreamResponse(readable);
}

// --- Server ---

// Session reuse handler defined above
async function getAccessToken(): Promise<string> {
  // First check environment variable
  const envToken = process.env.CURSOR_ACCESS_TOKEN;
  if (envToken) {
    return envToken;
  }
  
  // Fall back to credential manager
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) {
    throw new Error("No access token found. Set CURSOR_ACCESS_TOKEN or authenticate first.");
  }
  return token;
}

async function handleChatCompletions(req: Request, accessToken: string): Promise<Response> {
  let body: OpenAIChatRequest;

  try {
    body = (await req.json()) as OpenAIChatRequest;
  } catch {
    return createErrorResponse("Invalid JSON body");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return createErrorResponse("messages is required and must be a non-empty array");
  }

  let model: string;
  try {
    const models = await fetchUsableModels(accessToken);
    model = resolveModel(body.model ?? "auto", models);
  } catch (err) {
    console.warn("Failed to fetch models, using requested model directly:", err);
    model = body.model ?? "default";
  }

  const stream = body.stream ?? false;
  const clientProvidedTools = Array.isArray(body.tools) && body.tools.length > 0;

  // NOTE: We intentionally DON'T use session reuse for tool-calling flows.
  // 
  // When tool results are sent via BidiAppend to an existing Cursor stream,
  // the model stores its response in KV blobs instead of streaming it back.
  // Only heartbeats are received, no text_delta, and no turn_ended.
  // 
  // The workaround is to always use fresh sessions for tool-calling flows.
  // Tool results come back as new requests with full conversation history,
  // which works correctly (Flow A in TOOL_CALLING_INVESTIGATION.md).
  //
  // See docs/TOOL_CALLING_INVESTIGATION.md "Session 9" for full details.
  // Option B (extract text from KV blobs) is documented there for future reference.

  const prompt = messagesToPrompt(body.messages);
  const completionId = generateId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    return legacyStreamResponse({ body, model, prompt, completionId, created, accessToken });
  }

  try {
    const client = createAgentServiceClient(accessToken);
    const tools = body.tools as OpenAIToolDefinition[] | undefined;
    const content = await client.chat({ message: prompt, model, mode: AgentMode.AGENT, tools });

    const response: OpenAIChatResponse = {
      id: completionId,
      object: "chat.completion",
      created,
      model: body.model ?? "gpt-4o",
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
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(content.length / 4),
        total_tokens: Math.ceil((prompt.length + content.length) / 4),
      },
    };

    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return createErrorResponse(err.message ?? "Unknown error", "server_error", 500);
  }
}

async function handleModels(accessToken: string): Promise<Response> {
  try {
    const models = await fetchUsableModels(accessToken);
    const openaiModels = models.map(cursorModelToOpenAI);
    
    const response: OpenAIModelsResponse = {
      object: "list",
      data: openaiModels,
    };
    
    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return createErrorResponse(err.message ?? "Failed to fetch models", "server_error", 500);
  }
}

async function handleToolResult(req: Request): Promise<Response> {
  let body: ToolResultRequestBody;
  try {
    body = await req.json() as ToolResultRequestBody;
  } catch {
    return createErrorResponse("Invalid JSON body", "invalid_request", 400);
  }

  if (!body.tool_call_id || typeof body.tool_call_id !== "string") {
    return createErrorResponse("tool_call_id is required", "invalid_request", 400);
  }

  const pending = pendingToolResults.get(body.tool_call_id);
  if (!pending) {
    return createErrorResponse("tool_call_id not pending or already resolved", "invalid_request", 404);
  }

  // Remove from pending to avoid duplicate sends
  pendingToolResults.delete(body.tool_call_id);

  // If there's a resolve function, use it (new streaming approach)
  if (pending.resolve) {
    if (body.is_error || body.error) {
      pending.resolve({ error: body.error ?? body.content ?? "Tool returned an error" });
    } else {
      pending.resolve({ content: body.content ?? "" });
    }
    
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Fallback: directly send result to Cursor (old approach)
  // This code path is only used for backward compatibility when resolve function is not set
  const { execRequest, client } = pending;
  try {
    const content = body.content ?? "";
    const isError = body.is_error ?? false;
    
    // Handle different exec request types
    if (execRequest.type === 'mcp') {
      const mcpReq = execRequest as McpExecRequest & { type: 'mcp' };
      if (isError || body.error) {
        await client.sendToolResult(mcpReq, {
          error: body.error ?? content ?? "Tool returned an error",
        });
      } else {
        await client.sendToolResult(mcpReq, {
          success: { content, isError },
        });
      }
    } else if (execRequest.type === 'shell') {
      await client.sendShellResult(execRequest.id, execRequest.execId, execRequest.command, execRequest.cwd || process.cwd(), content, "", isError ? 1 : 0, 0);
    } else if (execRequest.type === 'read') {
      const lines = content.split('\n').length;
      await client.sendReadResult(execRequest.id, execRequest.execId, content, execRequest.path, lines, BigInt(content.length), false);
    } else if (execRequest.type === 'ls') {
      await client.sendLsResult(execRequest.id, execRequest.execId, content);
    } else if (execRequest.type === 'grep') {
      const files = content.trim().split('\n').filter(f => f.length > 0);
      await client.sendGrepResult(execRequest.id, execRequest.execId, execRequest.pattern || '', execRequest.path || process.cwd(), files);
    } else {
      return createErrorResponse(`Unknown exec request type: ${(execRequest as any).type}`, "invalid_request", 400);
    }

    return new Response(JSON.stringify({ status: "ok" }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return createErrorResponse(err.message ?? "Failed to send tool result", "server_error", 500);
  }
}

function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// --- Main ---

const PORT = parseInt(process.env.PORT ?? "18741", 10);

console.log("Starting OpenAI-compatible API server...");

let accessToken: string;
try {
  accessToken = await getAccessToken();
  console.log("Access token loaded successfully");
} catch (err: any) {
  console.error("Failed to get access token:", err.message);
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120, // 2 minutes to allow for long tool executions
  
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    
    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleCORS();
    }
    
    // Route requests
    if (url.pathname === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, accessToken);
    }
    
    if (url.pathname === "/v1/models" && method === "GET") {
      return handleModels(accessToken);
    }

    if (url.pathname === "/v1/tool_results" && method === "POST") {
      return handleToolResult(req);
    }
    
    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", version: "1.0.0" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    
    // 404 for unknown routes
    return createErrorResponse(`Unknown endpoint: ${method} ${url.pathname}`, "not_found", 404);
  },
});

console.log(`
╔════════════════════════════════════════════════════════════╗
║  OpenAI-Compatible API Server                              ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT.toString().padEnd(24)}║
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/chat/completions  - Chat completions           ║
║    POST /v1/tool_results     - Submit tool results         ║
║    GET  /v1/models            - List available models      ║
║    GET  /health               - Health check               ║
║                                                            ║
║  Usage with curl:                                          ║
║    curl http://localhost:${PORT}/v1/chat/completions \${" ".repeat(Math.max(0, 6 - PORT.toString().length))}║
║      -H "Content-Type: application/json" \                 ║
║      -d '{"model":"gpt-4o","messages":[...]}'              ║
║                                                            ║
║  Usage with OpenAI SDK:                                    ║
║    const openai = new OpenAI({                             ║
║      baseURL: "http://localhost:${PORT}/v1",${" ".repeat(Math.max(0, 20 - PORT.toString().length))}║
║      apiKey: "not-needed"                                  ║
║    });                                                     ║

╚════════════════════════════════════════════════════════════╝
`);

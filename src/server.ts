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

import { createAgentServiceClient, AgentMode, type OpenAIToolDefinition, type ExecRequest } from "./lib/api/agent-service";
import { FileCredentialManager } from "./lib/storage";

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

function messagesToPrompt(messages: OpenAIMessage[]): string {
  // For simple cases, just use the last user message
  // For more complex cases, we could format the conversation
  const userMessages = messages.filter(m => m.role === "user");
  const systemMessages = messages.filter(m => m.role === "system");
  
  let prompt = "";
  
  // Prepend system message if present
  if (systemMessages.length > 0) {
    prompt += systemMessages.map(m => m.content).join("\n") + "\n\n";
  }
  
  // Add the user message(s)
  if (userMessages.length > 0) {
    prompt += userMessages[userMessages.length - 1]?.content ?? "";
  }
  
  return prompt;
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

// --- Server ---

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
    body = await req.json() as OpenAIChatRequest;
  } catch {
    return createErrorResponse("Invalid JSON body");
  }
  
  // Validate required fields
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return createErrorResponse("messages is required and must be a non-empty array");
  }
  
  // Fetch available models and resolve the requested model
  let model: string;
  try {
    const models = await fetchUsableModels(accessToken);
    model = resolveModel(body.model ?? "auto", models);
  } catch (err) {
    // If model fetching fails, use the requested model as-is
    console.warn("Failed to fetch models, using requested model directly:", err);
    model = body.model ?? "default";
  }
  
  const prompt = messagesToPrompt(body.messages);
  const stream = body.stream ?? false;
  
  const client = createAgentServiceClient(accessToken);
  const completionId = generateId();
  const created = Math.floor(Date.now() / 1000);
  
  if (stream) {
    // Streaming response
    const encoder = new TextEncoder();
    let isClosed = false;
    let hasToolCalls = false;
    let toolCallIndex = 0;
    const toolCallIdMap: Map<string, number> = new Map(); // Map Cursor call IDs to OpenAI indices
    let toolExecutionCompleted = false;  // Track if we've completed tool execution
    let checkpointAfterToolExec = false;  // Track if we've received checkpoint after tool exec
    
    const readable = new ReadableStream({
      async start(controller) {
        try {
          // Send initial chunk with role
          const initialChunk: OpenAIStreamChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: body.model ?? "gpt-4o",
            choices: [{
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            }],
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
                  choices: [{
                    index: 0,
                    delta: { content: chunk.content },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(streamChunk)));
              }
            } else if (chunk.type === "tool_call_started" && chunk.toolCall) {
              // Map Cursor tool to OpenAI tool call format
              hasToolCalls = true;
              const currentIndex = toolCallIndex++;
              toolCallIdMap.set(chunk.toolCall.callId, currentIndex);
              
              // Generate OpenAI-style tool call ID
              const openaiToolCallId = `call_${chunk.toolCall.callId.replace(/-/g, "").slice(0, 24)}`;
              
              const toolCallChunk: OpenAIStreamChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: body.model ?? "gpt-4o",
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: currentIndex,
                      id: openaiToolCallId,
                      type: "function",
                      function: {
                        name: chunk.toolCall.name,
                        arguments: "", // Arguments come in partial updates or completed
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));
              
              // Also send initial arguments if available
              if (chunk.toolCall.arguments && chunk.toolCall.arguments !== "{}") {
                const argsChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: currentIndex,
                        function: {
                          arguments: chunk.toolCall.arguments,
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(argsChunk)));
              }
            } else if (chunk.type === "partial_tool_call" && chunk.toolCall && chunk.partialArgs) {
              // Stream partial arguments
              const idx = toolCallIdMap.get(chunk.toolCall.callId);
              if (idx !== undefined) {
                const partialChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: idx,
                        function: {
                          arguments: chunk.partialArgs,
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(partialChunk)));
              }
            } else if (chunk.type === "tool_call_completed" && chunk.toolCall) {
              // Tool call completed - we could send final args here if needed
              // For now, just track that tool calls happened
              hasToolCalls = true;
            } else if (chunk.type === "exec_request" && chunk.execRequest) {
              // Server is requesting tool execution
              const execReq = chunk.execRequest;
              
              console.log("[DEBUG] Received exec_request:", {
                type: execReq.type,
                id: execReq.id,
              });
              
              // Handle built-in exec types locally
              if (execReq.type === 'shell') {
                // Execute shell command locally
                console.log(`[DEBUG] Executing shell command: ${execReq.command}`);
                const startTime = Date.now();
                const cwd = execReq.cwd || process.cwd();
                try {
                  const proc = Bun.spawn(['sh', '-c', execReq.command], {
                    cwd,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  });
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
              } else if (execReq.type === 'ls') {
                // Execute ls locally
                console.log(`[DEBUG] Executing ls: ${execReq.path}`);
                try {
                  const proc = Bun.spawn(['ls', '-la'], {
                    cwd: execReq.path,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  });
                  const output = await new Response(proc.stdout).text();
                  await proc.exited;
                  console.log(`[DEBUG] LS result: ${output.slice(0, 200)}`);
                  
                  await client.sendLsResult(execReq.id, execReq.execId, output);
                  console.log("[DEBUG] Sent ls result");
                  toolExecutionCompleted = true;
                } catch (err: any) {
                  console.error("[ERROR] LS execution failed:", err.message);
                  await client.sendLsResult(execReq.id, execReq.execId, `Error: ${err.message}`);
                  toolExecutionCompleted = true;
                }
              } else if (execReq.type === 'request_context') {
                // Send request context (workspace info)
                console.log("[DEBUG] Sending request context");
                try {
                  await client.sendRequestContextResult(execReq.id, execReq.execId);
                  console.log("[DEBUG] Sent request context result");
                } catch (err: any) {
                  console.error("[ERROR] Request context failed:", err.message);
                }
              } else if (execReq.type === 'read') {
                // Read file locally
                console.log(`[DEBUG] Reading file: ${execReq.path}`);
                try {
                  const file = Bun.file(execReq.path);
                  const content = await file.text();
                  console.log(`[DEBUG] File content (${content.length} chars): ${content.slice(0, 200)}`);
                  
                  await client.sendReadResult(execReq.id, execReq.execId, content);
                  console.log("[DEBUG] Sent read result");
                } catch (err: any) {
                  console.error("[ERROR] File read failed:", err.message);
                  await client.sendReadResult(execReq.id, execReq.execId, `Error: ${err.message}`);
                }
              } else if (execReq.type === 'mcp') {
                // MCP tool call - convert to OpenAI format and emit
                hasToolCalls = true;
                const currentIndex = toolCallIndex++;
                
                console.log("[DEBUG] MCP tool call:", {
                  toolName: execReq.toolName,
                  args: execReq.args,
                });
                
                // Generate OpenAI-style tool call ID
                const openaiToolCallId = `call_${execReq.toolCallId.replace(/-/g, "").slice(0, 24) || execReq.id}`;
                
                // Send tool call start
                const toolCallChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: currentIndex,
                        id: openaiToolCallId,
                        type: "function",
                        function: {
                          name: execReq.toolName,
                          arguments: JSON.stringify(execReq.args),
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));
                
                // Send a placeholder result back to Cursor
                try {
                  await client.sendToolResult(execReq, {
                    success: {
                      content: `Tool "${execReq.toolName}" execution request forwarded to OpenAI client. Tool call ID: ${openaiToolCallId}`,
                      isError: false,
                    },
                  });
                  console.log("[DEBUG] Sent placeholder tool result for:", execReq.toolName);
                } catch (err: any) {
                  console.error("[ERROR] Failed to send tool result:", err.message);
                }
              }
            } else if (chunk.type === "error") {
              // Send error in stream format
              console.error("Cursor API error:", chunk.error);
              const errorChunk = {
                error: {
                  message: chunk.error ?? "Unknown error",
                  type: "server_error",
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
              break;
            } else if (chunk.type === "done") {
              // Stream is ending
              break;
            } else if (chunk.type === "checkpoint") {
              // Checkpoint received
              console.log("[DEBUG] Checkpoint received, toolExecutionCompleted:", toolExecutionCompleted);
              
              if (toolExecutionCompleted) {
                // If we've completed tool execution and received a checkpoint, end the stream
                // The model typically sends heartbeats after this but no more content
                console.log("[DEBUG] Tool execution completed, ending stream after checkpoint");
                checkpointAfterToolExec = true;
                break;
              }
              // Otherwise, continue waiting for exec messages that may come after checkpoint
              console.log("[DEBUG] Continuing to wait for exec messages...");
            }
          }
          
          if (!isClosed) {
            // Send final chunk with finish_reason
            const finalChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: body.model ?? "gpt-4o",
              choices: [{
                index: 0,
                delta: {},
                finish_reason: hasToolCalls ? "tool_calls" : "stop",
              }],
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
      }
    });
    
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } else {
    // Non-streaming response
    try {
      const tools = body.tools as OpenAIToolDefinition[] | undefined;
      const content = await client.chat({ message: prompt, model, mode: AgentMode.AGENT, tools });
      
      const response: OpenAIChatResponse = {
        id: completionId,
        object: "chat.completion",
        created,
        model: body.model ?? "gpt-4o",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        }],
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
║    GET  /v1/models            - List available models      ║
║    GET  /health               - Health check               ║
║                                                            ║
║  Usage with curl:                                          ║
║    curl http://localhost:${PORT}/v1/chat/completions \\${" ".repeat(Math.max(0, 6 - PORT.toString().length))}║
║      -H "Content-Type: application/json" \\                 ║
║      -d '{"model":"gpt-4o","messages":[...]}'              ║
║                                                            ║
║  Usage with OpenAI SDK:                                    ║
║    const openai = new OpenAI({                             ║
║      baseURL: "http://localhost:${PORT}/v1",${" ".repeat(Math.max(0, 20 - PORT.toString().length))}║
║      apiKey: "not-needed"                                  ║
║    });                                                     ║
╚════════════════════════════════════════════════════════════╝
`);

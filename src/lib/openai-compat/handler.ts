/**
 * OpenAI-Compatible Request Handler
 * 
 * Core request handling logic that can be used by both:
 * - Plugin's custom fetch function (serverless)
 * - Standalone server (Bun.serve)
 */

import {
  createAgentServiceClient,
  AgentMode,
  type OpenAIToolDefinition,
  type ExecRequest,
} from "../api/agent-service";
import { CursorClient } from "../api/cursor-client";
import { listCursorModels } from "../api/cursor-models";
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIModel,
  OpenAIModelsResponse,
  OpenAIStreamChunk,
} from "./types";
import {
  generateCompletionId,
  messagesToPrompt,
  mapExecRequestToTool,
  createErrorResponse,
  createSSEChunk,
  createSSEDone,
  makeStreamResponse,
  handleCORS,
  getModelOwner,
  createStreamChunk,
  generateToolCallId,
} from "./utils";
import { calculateTokenUsage } from "../utils/tokenizer";
import type { CursorModelInfo } from "../api/cursor-models";
import {
  cleanupExpiredSessions,
  collectToolMessages,
  createSessionId,
  findSessionIdInMessages,
  makeToolCallId,
  selectCallBase,
  type SessionLike,
} from "../session-reuse";

// --- Model Cache ---
interface ModelCache {
  models: CursorModelInfo[] | null;
  time: number;
}
const modelCache: ModelCache = { models: null, time: 0 };
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const SESSION_REUSE_TIMEOUT_MS = 15 * 60 * 1000;
const sessionMap = new Map<string, SessionLike>();

function sessionReuseEnabled(): boolean {
  return process.env.CURSOR_SESSION_REUSE !== "0";
}

/**
 * Get cached models or fetch fresh ones
 */
async function getCachedModels(accessToken: string): Promise<CursorModelInfo[]> {
  const now = Date.now();
  if (modelCache.models && now - modelCache.time < MODEL_CACHE_TTL) {
    return modelCache.models;
  }

  const cursorClient = new CursorClient(accessToken);
  const models = await listCursorModels(cursorClient);
  modelCache.models = models;
  modelCache.time = now;
  return models;
}

/**
 * Resolve a requested model name to its internal model ID
 * Maps displayModelId/aliases to the actual modelId used by the agent service
 */
function resolveModel(requestedModel: string, models: CursorModelInfo[]): string {
  // Direct match on modelId
  const directMatch = models.find(m => m.modelId === requestedModel);
  if (directMatch) {
    return directMatch.modelId;
  }

  // Match on displayModelId
  const displayMatch = models.find(m => m.displayModelId === requestedModel);
  if (displayMatch) {
    return displayMatch.modelId;
  }

  // Match on aliases
  const aliasMatch = models.find(m => m.aliases.includes(requestedModel));
  if (aliasMatch) {
    return aliasMatch.modelId;
  }

  // No match found, return as-is (let Cursor API handle it)
  return requestedModel;
}

/**
 * Options for the request handler
 */
export interface RequestHandlerOptions {
  /** Access token for Cursor API */
  accessToken: string;
  /** Optional logger for debugging */
  log?: (message: string, ...args: unknown[]) => void;
}

/**
 * Create a request handler function that can be used with custom fetch
 * 
 * @example
 * ```ts
 * const handler = createRequestHandler({ accessToken: "..." });
 * 
 * // Use in plugin
 * return {
 *   fetch: (input, init) => handler(new Request(input, init)),
 * };
 * 
 * // Use in server
 * Bun.serve({ fetch: handler });
 * ```
 */
export function createRequestHandler(options: RequestHandlerOptions) {
  const { accessToken, log = () => {} } = options;

  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    // Normalize pathname - handle both /v1/... and /chat/completions
    const pathname = url.pathname;

    log(`[OpenAI Compat] ${method} ${pathname}`);

    if (method === "OPTIONS") {
      return handleCORS();
    }

    // Handle chat completions - match both /v1/chat/completions and /chat/completions
    if ((pathname === "/v1/chat/completions" || pathname === "/chat/completions") && method === "POST") {
      return handleChatCompletions(req, accessToken, log);
    }

    // Handle models - match both /v1/models and /models
    if ((pathname === "/v1/models" || pathname === "/models") && method === "GET") {
      return handleModels(accessToken, log);
    }

    if (pathname === "/health" || pathname === "/") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return createErrorResponse(`Unknown endpoint: ${method} ${url.pathname}`, "not_found", 404);
  };
}

/**
 * Handle /v1/chat/completions requests
 */
async function handleChatCompletions(
  req: Request,
  accessToken: string,
  log: (message: string, ...args: unknown[]) => void
): Promise<Response> {
  let body: OpenAIChatRequest;
  try {
    body = await req.json() as OpenAIChatRequest;
  } catch {
    return createErrorResponse("Invalid JSON body");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return createErrorResponse("messages is required and must be a non-empty array");
  }

  // Resolve model name to internal model ID
  let model: string;
  try {
    const models = await getCachedModels(accessToken);
    model = resolveModel(body.model ?? "auto", models);
    log(`[OpenAI Compat] Resolved model "${body.model ?? "auto"}" to "${model}"`);
  } catch (err) {
    log("[OpenAI Compat] Failed to fetch models, using requested model directly:", err);
    model = body.model ?? "default";
  }

  const prompt = messagesToPrompt(body.messages);
  const stream = body.stream ?? false;
  const tools = body.tools as OpenAIToolDefinition[] | undefined;
  const toolsProvided = tools && tools.length > 0;

  // Log tool call status for debugging
  const toolCallCount = (body.messages as OpenAIMessage[])
    .filter(m => m.role === "assistant" && m.tool_calls)
    .reduce((acc, m) => acc + (m.tool_calls?.length ?? 0), 0);
  const toolResultCount = (body.messages as OpenAIMessage[])
    .filter(m => m.role === "tool").length;

  if (toolCallCount > 0) {
    log(`[OpenAI Compat] ${toolResultCount}/${toolCallCount} tool calls have results, passing ${tools?.length ?? 0} tools`);
  }

  const client = createAgentServiceClient(accessToken);
  const completionId = generateCompletionId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    return streamChatCompletion({
      client,
      prompt,
      model,
      tools,
      toolsProvided: toolsProvided ?? false,
      messages: body.messages,
      completionId,
      created,
      log,
    });
  }

  // Non-streaming response
  try {
    const content = await client.chat({ message: prompt, model, mode: AgentMode.AGENT, tools });
    const usage = calculateTokenUsage(prompt, content, model);

    return new Response(JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage,
    }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return createErrorResponse(message, "server_error", 500);
  }
}

/**
 * Stream chat completion response
 */
interface StreamParams {
  client: ReturnType<typeof createAgentServiceClient>;
  prompt: string;
  model: string;
  tools: OpenAIToolDefinition[] | undefined;
  toolsProvided: boolean;
  messages: OpenAIMessage[];
  completionId: string;
  created: number;
  log: (message: string, ...args: unknown[]) => void;
}

async function streamChatCompletion(params: StreamParams): Promise<Response> {
  const { client, prompt, model, tools, toolsProvided, messages, completionId, created, log } = params;

  // Route to session reuse if:
  // 1. Tools are provided (new request that may result in tool calls), OR
  // 2. Messages contain tool results (continuation with tool results)
  const hasToolMessages = messages.some(m => m.role === "tool" && m.tool_call_id);
  const shouldUseSessionReuse = sessionReuseEnabled() && (toolsProvided || hasToolMessages);
  
  if (shouldUseSessionReuse) {
    return streamChatCompletionWithSessionReuse({
      client,
      prompt,
      model,
      tools,
      toolsProvided,
      messages,
      completionId,
      created,
      log,
    });
  }
  
  const encoder = new TextEncoder();
  let isClosed = false;
  let mcpToolCallIndex = 0;
  let pendingEditToolCall: string | null = null;
  let accumulatedContent = "";

  const readable = new ReadableStream({
    async start(controller) {
      try {
        // Send initial chunk with role
        controller.enqueue(encoder.encode(createSSEChunk(
          createStreamChunk(completionId, model, created, { role: "assistant" })
        )));

        // Stream content
        for await (const chunk of client.chatStream({ message: prompt, model, mode: AgentMode.AGENT, tools })) {
          if (isClosed) break;

          if (chunk.type === "text" || chunk.type === "token") {
            if (chunk.content) {
              accumulatedContent += chunk.content;
              controller.enqueue(encoder.encode(createSSEChunk(
                createStreamChunk(completionId, model, created, { content: chunk.content })
              )));
            }
          } else if (chunk.type === "kv_blob_assistant" && chunk.blobContent) {
            log("[OpenAI Compat] Emitting assistant content from KV blob");
            accumulatedContent += chunk.blobContent;
            controller.enqueue(encoder.encode(createSSEChunk(
              createStreamChunk(completionId, model, created, { content: chunk.blobContent })
            )));
          } else if (chunk.type === "tool_call_started" && chunk.toolCall) {
            // Track file-modifying tool calls
            if (chunk.toolCall.name === "edit" || chunk.toolCall.name === "apply_diff") {
              pendingEditToolCall = chunk.toolCall.callId;
              log("[OpenAI Compat] File-modifying tool started, will handle internal read locally");
            }
          } else if (chunk.type === "exec_request" && chunk.execRequest) {
            const execReq = chunk.execRequest;

            // Skip context requests
            if (execReq.type === "request_context") {
              continue;
            }

            // Handle internal reads for edit flows
            if (execReq.type === "read" && pendingEditToolCall) {
              log("[OpenAI Compat] Handling internal read for edit flow locally");
              try {
                const file = Bun.file(execReq.path);
                const content = await file.text();
                const stats = await file.stat();
                const totalLines = content.split("\n").length;
                await client.sendReadResult(execReq.id, execReq.execId, content, execReq.path, totalLines, BigInt(stats.size), false);
                log("[OpenAI Compat] Internal read completed for edit flow");
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : "Unknown error";
                await client.sendReadResult(execReq.id, execReq.execId, `Error: ${message}`, execReq.path, 0, 0n, false);
              }
              continue;
            }

            // Emit exec requests as OpenAI tool calls when tools are provided
            if (toolsProvided) {
              const { toolName, toolArgs } = mapExecRequestToTool(execReq);
              if (toolName && toolArgs) {
                const currentIndex = mcpToolCallIndex++;
                const openaiToolCallId = generateToolCallId(completionId, currentIndex);

                log(`[OpenAI Compat] Emitting tool call: ${toolName} (type: ${execReq.type})`);

                // Emit the tool call
                const toolCallChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: currentIndex,
                        id: openaiToolCallId,
                        type: "function",
                        function: {
                          name: toolName,
                          arguments: JSON.stringify(toolArgs),
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));

                // Emit finish with tool_calls reason
                controller.enqueue(encoder.encode(createSSEChunk(
                  createStreamChunk(completionId, model, created, {}, "tool_calls")
                )));

                controller.enqueue(encoder.encode(createSSEDone()));
                isClosed = true;
                controller.close();
                return;
              }
            }

            // Execute built-in tools internally when no tools provided
            if (!toolsProvided && execReq.type !== "mcp") {
              await executeBuiltinTool(client, execReq, log);
            }
          } else if (chunk.type === "error") {
            controller.enqueue(encoder.encode(createSSEChunk({
              error: { message: chunk.error ?? "Unknown error", type: "server_error" },
            })));
            break;
          } else if (chunk.type === "done") {
            break;
          }
        }

        // Send final chunk with usage
        if (!isClosed) {
          const usage = calculateTokenUsage(prompt, accumulatedContent, model);
          const finalChunk: OpenAIStreamChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
            }],
            usage,
          };
          controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));
          controller.enqueue(encoder.encode(createSSEDone()));
          controller.close();
        }
      } catch (err: unknown) {
        if (!isClosed) {
          try {
            controller.error(err);
          } catch {
            // Controller may already be closed
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

async function streamChatCompletionWithSessionReuse(params: StreamParams): Promise<Response> {
  const { client, prompt, model, tools, messages, completionId, created, log } = params;

  await cleanupExpiredSessions(
    sessionMap as unknown as Map<string, { iterator?: AsyncIterator<unknown>; lastActivity: number }>,
    SESSION_REUSE_TIMEOUT_MS
  );

  const encoder = new TextEncoder();
  let isClosed = false;
  let mcpToolCallIndex = 0;
  let pendingEditToolCall: string | null = null;
  let accumulatedContent = "";

  // ARCHITECTURAL NOTE: We always start fresh requests when tool results arrive.
  // See session-reuse.ts for detailed explanation of why true session reuse isn't possible.
  // The session infrastructure below is retained for internal read handling and future improvements.
  
  const existingSessionId = findSessionIdInMessages(messages);
  const toolMessages = collectToolMessages(messages);

  log(`[Session Reuse] existingSessionId=${existingSessionId ?? "null"}, toolMessages.length=${toolMessages.length}`);
  if (toolMessages.length > 0) {
    log(`[Session Reuse] toolMessages tool_call_ids: ${toolMessages.map(m => m.tool_call_id).join(", ")}`);
  }

  let sessionId = existingSessionId ?? createSessionId();
  let session = existingSessionId ? sessionMap.get(existingSessionId) : undefined;
  
  log(`[Session Reuse] sessionId=${sessionId}, session found=${!!session}, sessionMap.size=${sessionMap.size}`);

  // IMPORTANT: bidiAppend tool results don't trigger server continuation - start fresh request instead
  if (toolMessages.length > 0 && session) {
    log(`[Session Reuse] Tool messages present - closing old session ${sessionId} and starting fresh`);
    try {
      await session.iterator.return?.();
    } catch (err: unknown) {
      log("[Session Reuse] Failed to close prior session iterator:", err);
    }
    sessionMap.delete(sessionId);
    session = undefined;
    sessionId = createSessionId();
  }

  if (!session) {
    log(`[Session Reuse] Creating NEW session ${sessionId}`);
    const iterator = client
      .chatStream({ message: prompt, model, mode: AgentMode.AGENT, tools })
      [Symbol.asyncIterator]();

    session = {
      id: sessionId,
      iterator,
      pendingExecs: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      state: "running",
      client: {
        sendToolResult: client.sendToolResult.bind(client),
        sendShellResult: client.sendShellResult.bind(client),
        sendReadResult: client.sendReadResult.bind(client),
        sendLsResult: client.sendLsResult.bind(client),
        sendGrepResult: client.sendGrepResult.bind(client),
        sendWriteResult: client.sendWriteResult.bind(client),
        sendResumeAction: client.sendResumeAction.bind(client),
      },
    };

    sessionMap.set(sessionId, session);
  } else {
    sessionId = session.id;
  }

  const activeSession = session;
  activeSession.lastActivity = Date.now();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(createSSEChunk(createStreamChunk(completionId, model, created, { role: "assistant" })))
        );

        while (!isClosed) {
          log(`[OpenAI Compat] Waiting for next chunk from iterator for session ${sessionId}...`);
          const { done, value } = await activeSession.iterator.next();
          log(`[OpenAI Compat] Iterator returned: done=${done}, value type=${(value as { type?: string })?.type || 'N/A'}`);

          if (done) {
            sessionMap.delete(sessionId);
            const usage = calculateTokenUsage(prompt, accumulatedContent, model);
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
              usage,
            };

            controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));
            controller.enqueue(encoder.encode(createSSEDone()));
            controller.close();
            return;
          }

          const chunk = value as {
            type: string;
            content?: string;
            blobContent?: string;
            toolCall?: { name?: string; callId: string };
            execRequest?: ExecRequest;
            error?: string;
          };

          if (chunk.type === "text" || chunk.type === "token") {
            if (chunk.content) {
              accumulatedContent += chunk.content;
              activeSession.lastActivity = Date.now();
              controller.enqueue(
                encoder.encode(
                  createSSEChunk(createStreamChunk(completionId, model, created, { content: chunk.content }))
                )
              );
            }
            continue;
          }

          if (chunk.type === "kv_blob_assistant" && chunk.blobContent) {
            accumulatedContent += chunk.blobContent;
            session.lastActivity = Date.now();
            controller.enqueue(
              encoder.encode(
                createSSEChunk(createStreamChunk(completionId, model, created, { content: chunk.blobContent }))
              )
            );
            continue;
          }

          if (chunk.type === "tool_call_started" && chunk.toolCall) {
            if (chunk.toolCall.name === "edit" || chunk.toolCall.name === "apply_diff") {
              pendingEditToolCall = chunk.toolCall.callId;
            }
            continue;
          }

          if (chunk.type === "exec_request" && chunk.execRequest) {
            const execReq = chunk.execRequest;

            if (execReq.type === "request_context") {
              continue;
            }

            if (execReq.type === "read" && pendingEditToolCall) {
              try {
                const file = Bun.file(execReq.path);
                const content = await file.text();
                const stats = await file.stat();
                const totalLines = content.split("\n").length;
                await client.sendReadResult(
                  execReq.id,
                  execReq.execId,
                  content,
                  execReq.path,
                  totalLines,
                  BigInt(stats.size),
                  false
                );
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : "Unknown error";
                await client.sendReadResult(execReq.id, execReq.execId, `Error: ${message}`, execReq.path, 0, 0n, false);
              }

              try {
                await client.sendResumeAction();
              } catch (err: unknown) {
                log("[OpenAI Compat] Failed to send ResumeAction:", err);
              }

              continue;
            }

            const { toolName, toolArgs } = mapExecRequestToTool(execReq);
            if (toolName && toolArgs) {
              const currentIndex = mcpToolCallIndex++;
              const callBase = selectCallBase(execReq);
              const toolCallId = makeToolCallId(sessionId, callBase);
              log(`[Session ${sessionId}] Storing pendingExec: toolCallId=${toolCallId}, callBase=${callBase}, execReq.type=${execReq.type}, execReq.execId=${(execReq as { execId?: string }).execId ?? "undefined"}, execReq.id=${(execReq as { id?: number }).id ?? "undefined"}`);
              activeSession.pendingExecs.set(toolCallId, execReq);
              activeSession.state = "waiting_tool";
              activeSession.lastActivity = Date.now();

              const toolCallChunk: OpenAIStreamChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: currentIndex,
                          id: toolCallId,
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
              controller.enqueue(
                encoder.encode(createSSEChunk(createStreamChunk(completionId, model, created, {}, "tool_calls")))
              );
              controller.enqueue(encoder.encode(createSSEDone()));

              isClosed = true;
              controller.close();
              return;
            }

            await executeBuiltinTool(client, execReq, log);
            continue;
          }

          if (chunk.type === "error") {
            sessionMap.delete(sessionId);
            controller.enqueue(
              encoder.encode(
                createSSEChunk({
                  error: { message: chunk.error ?? "Unknown error", type: "server_error" },
                })
              )
            );
            controller.enqueue(encoder.encode(createSSEDone()));
            controller.close();
            return;
          }

          if (chunk.type === "done") {
            sessionMap.delete(sessionId);
            break;
          }
        }

        const usage = calculateTokenUsage(prompt, accumulatedContent, model);
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
          usage,
        };

        controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));
        controller.enqueue(encoder.encode(createSSEDone()));
        controller.close();
      } catch (err: unknown) {
        if (!isClosed) {
          try {
            controller.error(err);
          } catch (innerErr: unknown) {
            log("[OpenAI Compat] Failed to signal stream error:", innerErr);
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

/**
 * Execute built-in tool internally
 */
async function executeBuiltinTool(
  client: ReturnType<typeof createAgentServiceClient>,
  execReq: ExecRequest,
  log: (message: string, ...args: unknown[]) => void
): Promise<void> {
  log(`[OpenAI Compat] Executing built-in tool internally: ${execReq.type}`);

  if (execReq.type === "shell") {
    const cwd = execReq.cwd || process.cwd();
    const startTime = Date.now();
    try {
      const proc = Bun.spawn(["sh", "-c", execReq.command], { cwd, stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const executionTimeMs = Date.now() - startTime;
      await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, stdout, stderr, exitCode, executionTimeMs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const executionTimeMs = Date.now() - startTime;
      await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, "", `Error: ${message}`, 1, executionTimeMs);
    }
  } else if (execReq.type === "read") {
    try {
      const file = Bun.file(execReq.path);
      const content = await file.text();
      const stats = await file.stat();
      const totalLines = content.split("\n").length;
      await client.sendReadResult(execReq.id, execReq.execId, content, execReq.path, totalLines, BigInt(stats.size), false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await client.sendReadResult(execReq.id, execReq.execId, `Error: ${message}`, execReq.path, 0, 0n, false);
    }
  } else if (execReq.type === "ls") {
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(execReq.path, { withFileTypes: true });
      const files = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).join("\n");
      await client.sendLsResult(execReq.id, execReq.execId, files);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await client.sendLsResult(execReq.id, execReq.execId, `Error: ${message}`);
    }
  } else if (execReq.type === "grep") {
    try {
      let files: string[] = [];
      if (execReq.glob) {
        const globber = new Bun.Glob(execReq.glob);
        files = Array.from(globber.scanSync(execReq.path || process.cwd()));
      } else if (execReq.pattern) {
        const rg = Bun.spawn(["rg", "-l", execReq.pattern, execReq.path || process.cwd()], { stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(rg.stdout).text();
        files = stdout.split("\n").filter(f => f.length > 0);
      }
      await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || execReq.glob || "", execReq.path || process.cwd(), files);
    } catch {
      await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || execReq.glob || "", execReq.path || process.cwd(), []);
    }
  } else if (execReq.type === "write") {
    try {
      const { dirname } = await import("node:path");
      const { mkdir } = await import("node:fs/promises");
      const dir = dirname(execReq.path);
      await mkdir(dir, { recursive: true });

      const content = execReq.fileBytes && execReq.fileBytes.length > 0
        ? execReq.fileBytes
        : execReq.fileText;
      await Bun.write(execReq.path, content);

      const file = Bun.file(execReq.path);
      const stats = await file.stat();
      const linesCreated = typeof content === "string"
        ? content.split("\n").length
        : new TextDecoder().decode(content).split("\n").length;

      await client.sendWriteResult(execReq.id, execReq.execId, {
        success: {
          path: execReq.path,
          linesCreated,
          fileSize: Number(stats.size),
          fileContentAfterWrite: execReq.returnFileContentAfterWrite ? await file.text() : undefined,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await client.sendWriteResult(execReq.id, execReq.execId, {
        error: { path: execReq.path, error: message },
      });
    }
  }
}

/**
 * Handle /v1/models requests
 */
async function handleModels(
  accessToken: string,
  _log: (message: string, ...args: unknown[]) => void
): Promise<Response> {
  try {
    const cursorClient = new CursorClient(accessToken);
    const models = await listCursorModels(cursorClient);

    const openaiModels: OpenAIModel[] = models.map(m => ({
      id: m.displayModelId || m.modelId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: getModelOwner(m.displayName ?? ""),
    }));

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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch models";
    return createErrorResponse(message, "server_error", 500);
  }
}

/**
 * Create a custom fetch handler for use in OpenCode plugin
 * 
 * This wraps createRequestHandler to match the FetchInput signature
 * that OpenCode expects from plugins.
 */
export function createPluginFetch(options: RequestHandlerOptions): (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response> {
  const handler = createRequestHandler(options);

  return async (input, init) => {
    // Create a proper Request object
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = new Request(url, init);
    return handler(request);
  };
}

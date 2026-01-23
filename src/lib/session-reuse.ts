/**
 * Session Reuse Utilities
 * 
 * ARCHITECTURAL NOTE:
 * True session reuse (keeping a single bidirectional stream open across multiple
 * OpenAI API requests) is not possible due to a fundamental mismatch:
 * 
 * - OpenAI API: Request/response model. Must close HTTP response to return tool_calls
 *   to the client, then receive a new HTTP request with tool results.
 * 
 * - Cursor's bidirectional streaming: Keeps a single stream open. Tool execution
 *   happens locally while the stream stays open. Results are sent via bidiAppend,
 *   and the server continues generating automatically.
 * 
 * Our workaround: When tool results come back in a new request, we close any
 * existing session and start completely fresh. The messagesToPrompt() function
 * formats the full conversation history including prior tool calls and results,
 * so the server has full context even though we're starting a new stream.
 * 
 * The session infrastructure (SessionLike, pendingExecs, etc.) is retained for:
 * 1. Potential future improvements if we find a way to bridge the gap
 * 2. Internal read handling during edit flows (single-request scope)
 */

import crypto from "node:crypto";
import type { ExecRequest, McpExecRequest } from "./api/agent-service";

export interface OpenAIToolCallLite {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIMessageLite {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: OpenAIToolCallLite[];
  tool_call_id?: string;
}

export interface SessionClient {
  sendToolResult: (
    execRequest: McpExecRequest & { type: "mcp" },
    result: { success?: { content: string; isError?: boolean }; error?: string }
  ) => Promise<void>;
  sendShellResult: (
    id: number,
    execId: string | undefined,
    command: string,
    cwd: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    executionTimeMs?: number
  ) => Promise<void>;
  sendReadResult: (
    id: number,
    execId: string | undefined,
    content: string,
    path: string,
    totalLines?: number,
    fileSize?: bigint,
    truncated?: boolean
  ) => Promise<void>;
  sendLsResult: (id: number, execId: string | undefined, filesString: string) => Promise<void>;
  sendGrepResult: (
    id: number,
    execId: string | undefined,
    pattern: string,
    path: string,
    files: string[]
  ) => Promise<void>;
  sendWriteResult: (
    id: number,
    execId: string | undefined,
    result: { 
      success?: { path: string; linesCreated: number; fileSize: number; fileContentAfterWrite?: string }; 
      error?: { path: string; error: string };
    }
  ) => Promise<void>;
  sendResumeAction?: () => Promise<void>;
}

export interface SessionLike {
  id: string;
  iterator: AsyncIterator<unknown>;
  pendingExecs: Map<string, ExecRequest>;
  createdAt: number;
  lastActivity: number;
  state: "running" | "waiting_tool";
  client: SessionClient;
}

export function createSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function makeToolCallId(sessionId: string, callBase: string): string {
  return `sess_${sessionId}__call_${callBase}`;
}

export function parseSessionIdFromToolCallId(toolCallId: string | null | undefined): string | null {
  if (!toolCallId) return null;
  const match = toolCallId.match(/^sess_([a-zA-Z0-9]+)__call_/);
  if (!match) return null;
  return match[1] ?? null;
}

export function findSessionIdInMessages(messages: OpenAIMessageLite[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "tool" && msg.tool_call_id) {
      const sessionId = parseSessionIdFromToolCallId(msg.tool_call_id);
      if (sessionId) return sessionId;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const sessionId = parseSessionIdFromToolCallId(tc?.id);
        if (sessionId) return sessionId;
      }
    }
  }
  return null;
}

export function collectToolMessages(messages: OpenAIMessageLite[]): OpenAIMessageLite[] {
  return messages.filter((m) => m?.role === "tool" && !!m.tool_call_id);
}

export function extractMessageContent(message: OpenAIMessageLite): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as unknown[])
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in (part as Record<string, unknown>)) {
          const text = (part as Record<string, unknown>).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function selectCallBase(execReq: ExecRequest): string {
  const raw =
    execReq.type === "mcp"
      ? execReq.toolCallId
      : (execReq as { execId?: string }).execId ?? String((execReq as { id?: number }).id ?? crypto.randomUUID());
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.slice(0, 32) || crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function mapExecRequestToTool(execReq: ExecRequest): {
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
} {
  if (execReq.type === "shell") {
    const toolArgs: Record<string, unknown> = { command: execReq.command };
    if (execReq.description) toolArgs.description = execReq.description;
    if (execReq.cwd) toolArgs.workdir = execReq.cwd;
    return { toolName: "bash", toolArgs };
  }
  if (execReq.type === "read") {
    return { toolName: "read", toolArgs: { filePath: execReq.path } };
  }
  if (execReq.type === "ls") {
    return { toolName: "list", toolArgs: { path: execReq.path } };
  }
  if (execReq.type === "grep") {
    const toolName = execReq.glob ? "glob" : "grep";
    const toolArgs = execReq.glob
      ? { pattern: execReq.glob, path: execReq.path }
      : { pattern: execReq.pattern, path: execReq.path };
    return { toolName, toolArgs };
  }
  if (execReq.type === "mcp") {
    return { toolName: execReq.toolName, toolArgs: execReq.args };
  }
  if (execReq.type === "write") {
    return { toolName: "write", toolArgs: { filePath: execReq.path, content: execReq.fileText } };
  }
  return { toolName: null, toolArgs: null };
}

export function safeParseJson(input: string): Record<string, unknown> | null {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function sendToolResultsToCursor(
  session: SessionLike,
  toolMessages: OpenAIMessageLite[]
): Promise<boolean> {
  let processedAny = false;

  for (const message of toolMessages) {
    if (!message.tool_call_id) continue;

    console.log(
      `[Session ${session.id}] Looking up tool_call_id=${message.tool_call_id}, available keys=[${Array.from(session.pendingExecs.keys()).join(", ")}]`
    );

    const execReq = session.pendingExecs.get(message.tool_call_id);
    if (!execReq) {
      console.warn(
        `[Session ${session.id}] Tool result for unknown tool_call_id ${message.tool_call_id}; ignoring`
      );
      continue;
    }

    const content = extractMessageContent(message);

    try {
      if (execReq.type === "mcp") {
        await session.client.sendToolResult(execReq, {
          success: { content, isError: false },
        });
      } else if (execReq.type === "shell") {
        const parsed = safeParseJson(content);
        const stdout = parsed && typeof parsed.stdout === "string" ? parsed.stdout : content;
        const stderr = parsed && typeof parsed.stderr === "string" ? parsed.stderr : "";
        const exitCode = parsed && typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
        const executionTimeMs = parsed && typeof parsed.executionTimeMs === "number" ? parsed.executionTimeMs : undefined;
        await session.client.sendShellResult(
          execReq.id,
          execReq.execId,
          execReq.command,
          execReq.cwd || process.cwd(),
          stdout,
          stderr,
          exitCode,
          executionTimeMs
        );
      } else if (execReq.type === "read") {
        await session.client.sendReadResult(
          execReq.id,
          execReq.execId,
          content,
          execReq.path,
          content.split("\n").length,
          BigInt(content.length),
          false
        );
      } else if (execReq.type === "ls") {
        await session.client.sendLsResult(execReq.id, execReq.execId, content);
      } else if (execReq.type === "grep") {
        const files = content.trim().split("\n").filter(Boolean);
        const pattern = execReq.glob ?? execReq.pattern ?? "";
        const path = execReq.path ?? process.cwd();
        await session.client.sendGrepResult(execReq.id, execReq.execId, pattern, path, files);
      } else if (execReq.type === "write") {
        const parsed = safeParseJson(content);
        const parsedError = parsed?.error;

        if (typeof parsedError === "string" && parsedError.length > 0) {
          await session.client.sendWriteResult(execReq.id, execReq.execId, {
            error: { path: execReq.path, error: parsedError },
          });
        } else {
          const linesCreatedValue = parsed?.linesCreated;
          const fileSizeValue = parsed?.fileSize;
          const fileContentAfterWriteValue = parsed?.fileContentAfterWrite;

          const linesCreated =
            typeof linesCreatedValue === "number" ? linesCreatedValue : content.split("\n").length;
          const fileSize = typeof fileSizeValue === "number" ? fileSizeValue : content.length;
          const fileContentAfterWrite =
            typeof fileContentAfterWriteValue === "string" ? fileContentAfterWriteValue : undefined;

          await session.client.sendWriteResult(execReq.id, execReq.execId, {
            success: {
              path: execReq.path,
              linesCreated,
              fileSize,
              fileContentAfterWrite,
            },
          });
        }
      } else {
        return false;
      }
    } catch (err) {
      console.error(`[Session ${session.id}] Failed to send tool result for ${message.tool_call_id}:`, err);
      return false;
    }

    session.pendingExecs.delete(message.tool_call_id);
    processedAny = true;
  }

  if (processedAny) {
    session.state = "running";
    session.lastActivity = Date.now();
    console.log(`[Session ${session.id}] processedAny=true, tool results sent. Waiting for server to continue...`);
  } else {
    console.log(`[Session ${session.id}] processedAny=false, no matching tool results found`);
  }

  return processedAny;
}

export async function cleanupExpiredSessions(
  sessionMap: Map<string, { iterator?: AsyncIterator<unknown>; lastActivity: number }>,
  timeoutMs: number,
  now: number = Date.now()
): Promise<void> {
  for (const [sessionId, session] of sessionMap) {
    if (now - session.lastActivity > timeoutMs) {
      try {
        await session.iterator?.return?.();
      } catch (err) {
        console.warn(`[Session ${sessionId}] Failed to close expired iterator:`, err);
      } finally {
        sessionMap.delete(sessionId);
      }
    }
  }
}

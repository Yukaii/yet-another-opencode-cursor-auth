# Cursor CLI vs OpenAI Architecture Comparison

**Date**: December 10, 2025  
**Status**: Documented after KV blob investigation

## Overview

This document explains the fundamental architectural differences between OpenAI's API and Cursor's Agent API, and why session reuse fails when bridging between them.

## OpenAI Architecture (Stateless, Client-Driven)

```
┌─────────────────────────────────────────────────────────────────┐
│                     OpenAI Tool Flow                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Client                              OpenAI API                 │
│    │                                     │                      │
│    │──── Request + tools ───────────────>│                      │
│    │<─── Stream: text OR tool_calls ─────│                      │
│    │     (finish_reason: "tool_calls")   │                      │
│    │                                     │                      │
│    │  [Client executes tool locally]     │                      │
│    │                                     │                      │
│    │──── NEW Request ───────────────────>│                      │
│    │     + full history                  │                      │
│    │     + tool result                   │                      │
│    │<─── Stream: text ───────────────────│                      │
│    │     (finish_reason: "stop")         │                      │
│                                                                 │
│  Key: Each request is INDEPENDENT. Server is STATELESS.         │
│       Client owns conversation state and tool execution.        │
└─────────────────────────────────────────────────────────────────┘
```

### Characteristics

- **Stateless server**: No session ID, no server-side state
- **Client-driven**: Client decides when to send tool results
- **Full history**: Every request includes complete conversation
- **Clear boundaries**: `finish_reason` explicitly signals turn end
- **Tool execution**: Always on client side

---

## Cursor CLI Architecture (Stateful, Server-Driven)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cursor CLI Tool Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CLI Client                           Cursor Server             │
│    │                                     │                      │
│    │──── RunSSE (start session) ────────>│                      │
│    │<─── Stream opened ──────────────────│                      │
│    │                                     │                      │
│    │──── BidiAppend (user message) ─────>│                      │
│    │<─── Stream: text_delta ─────────────│                      │
│    │<─── Stream: exec_server_message ────│  ← Server requests   │
│    │     (tool execution request)        │    tool execution!   │
│    │                                     │                      │
│    │──── BidiAppend (tool result) ──────>│  ← Same session      │
│    │<─── Stream: text_delta ─────────────│                      │
│    │<─── Stream: turn_ended ─────────────│                      │
│    │                                     │                      │
│    │──── BidiAppend (next message) ─────>│  ← Continue session  │
│    │     ...                             │                      │
│                                                                 │
│  Key: Single PERSISTENT session. Server DRIVES tool execution.  │
│       Server owns conversation state via KV blob store.         │
└─────────────────────────────────────────────────────────────────┘
```

### Characteristics

- **Stateful server**: Session ID, server-side KV blob storage
- **Server-driven**: Server requests tool execution via `exec_server_message`
- **Incremental updates**: Only send deltas via BidiAppend
- **Implicit boundaries**: `turn_ended` fires when model is done
- **Tool execution**: Server expects CLI to execute and report back

---

## Key Architectural Differences

| Aspect | OpenAI | Cursor CLI |
|--------|--------|------------|
| **Session Model** | Stateless (no session) | Stateful (persistent session) |
| **State Location** | Client holds all state | Server holds state in KV blobs |
| **Tool Execution Trigger** | Client sees `tool_calls` in response | Server sends `exec_server_message` |
| **Tool Result Delivery** | New request with full history | BidiAppend to same session |
| **Turn Boundary** | `finish_reason: "stop"/"tool_calls"` | `turn_ended` message |
| **Conversation History** | Client sends full history each time | Server reconstructs from blobs |
| **Streaming Protocol** | SSE with JSON chunks | gRPC-Web with protobuf frames |

---

## Why the Incompatibility Occurs

When we try to use Cursor's API with OpenAI's pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                    The Mismatch                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  OpenCode (OpenAI client)              Cursor Server            │
│    │                                     │                      │
│    │──── Request 1 + tools ─────────────>│                      │
│    │<─── exec_server_message ────────────│  Tool request        │
│    │     (we translate to tool_calls)    │                      │
│    │                                     │                      │
│    │  [OpenCode executes tool]           │                      │
│    │                                     │                      │
│    │──── Request 2 (NEW session!) ──────>│  ← PROBLEM!          │
│    │     + full history + tool result    │                      │
│    │                                     │                      │
│    │  Cursor: "What tool result?         │                      │
│    │   I never asked for a tool!"        │                      │
│    │                                     │                      │
│    │<─── Streams new response ───────────│  May call tool again │
│                                                                 │
│  The NEW session doesn't know about the previous tool request.  │
│  Cursor treats the tool result as just conversation history.    │
└─────────────────────────────────────────────────────────────────┘
```

---

## What Happens with Session Reuse (BidiAppend)

When we try to match Cursor's expected flow:

```
┌─────────────────────────────────────────────────────────────────┐
│              Session Reuse Attempt                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Proxy                                 Cursor Server            │
│    │                                     │                      │
│    │──── RunSSE + BidiAppend ───────────>│                      │
│    │<─── exec_server_message (shell) ────│                      │
│    │                                     │                      │
│    │──── BidiAppend (shell_result) ─────>│  ✓ Accepted          │
│    │<─── tool_call_completed ────────────│  ✓ Acknowledged      │
│    │                                     │                      │
│    │  [Waiting for text_delta...]        │                      │
│    │                                     │                      │
│    │<─── KV SET (assistant blob) ────────│  ← Response stored!  │
│    │<─── heartbeat ──────────────────────│                      │
│    │<─── heartbeat ──────────────────────│                      │
│    │<─── heartbeat ──────────────────────│  No text_delta!      │
│    │     ...forever...                   │  No turn_ended!      │
│                                                                 │
│  Server stores response in KV blob instead of streaming.        │
│  This is likely a Cursor CLI-specific behavior or config.       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Why Cursor Stores in KV Instead of Streaming

The investigation revealed Cursor stores responses in KV blobs after BidiAppend. Possible reasons:

1. **CLI-specific headers**: Cursor CLI may send special headers that enable streaming
   - We tried `x-cursor-streaming: true` but it didn't help
   
2. **Client capability signaling**: CLI may signal it can handle certain response formats
   
3. **Checkpoint-based architecture**: Cursor's design assumes clients can reconstruct state from checkpoints/blobs for crash recovery

4. **Tool execution model**: CLI handles `exec_server_message` synchronously within the stream, while we're trying to bridge async OpenAI semantics

---

## KV Blob Contents (From Investigation)

When session reuse is attempted, Cursor stores these blobs:

| Blob | Size | Type | Role | Content |
|------|------|------|------|---------|
| #0 | 122b | text | - | Empty/metadata |
| #1 | ~8KB | json | `system` | System prompt |
| #2 | 242b | json | `user` | User message |
| #3 | 241b | json | `user` | Additional context |
| #4 | 36b | protobuf | - | Unknown metadata |
| #5 | 465b | json | `assistant` | **Tool call (NOT text!)** |
| #6 | 905b | json | `tool` | Tool result storage |
| #7 | 305b | protobuf | - | Checkpoint data |
| #8 | 70b | protobuf | - | Unknown metadata |

### Critical Finding: Assistant Blob Structure

The assistant blob (#5) contains:
```json
{
  "id": "...",
  "role": "assistant",
  "content": [
    {
      "type": "tool-call",
      "toolCallId": "call_...",
      "toolName": "Shell",
      "args": {"command": "..."}
    }
  ]
}
```

The `content` field is an **array of tool-call objects**, not text! This means:
1. Model receives tool result
2. Model generates response → another tool call
3. Response stored in KV blob (not streamed)
4. Stream only sends heartbeats
5. `turn_ended` never fires

---

## The Working Solution: Fresh Sessions

```
┌─────────────────────────────────────────────────────────────────┐
│              Fresh Session Approach (Current)                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  OpenCode          Proxy                    Cursor Server       │
│    │                 │                           │              │
│    │── Req 1 ───────>│── New Session ───────────>│              │
│    │                 │<── exec_server_message ───│              │
│    │<── tool_calls ──│   (translated)            │              │
│    │                 │                           │              │
│    │  [Execute]      │                           │              │
│    │                 │                           │              │
│    │── Req 2 ───────>│── New Session ───────────>│              │
│    │  (w/ history)   │   (history in prompt)     │              │
│    │                 │<── text_delta ────────────│              │
│    │<── text ────────│<── turn_ended ────────────│              │
│                                                                 │
│  Each request = fresh session. History passed as prompt text.   │
│  Cursor sees it as a new conversation each time.                │
│  Works because Cursor always streams for new sessions!          │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Works

1. **Fresh sessions always stream** (no KV blob issue)
2. **History is embedded in the prompt**, so Cursor has full context
3. **No session state mismatch**
4. **Clean turn boundaries**

---

## Summary

| Architecture | Tool Flow | Why It Works/Fails |
|--------------|-----------|-------------------|
| **OpenAI native** | Client sends new request with tool result | Stateless, each request independent |
| **Cursor CLI native** | BidiAppend tool result to same session | Stateful, server drives execution |
| **Our proxy (session reuse)** | BidiAppend to Cursor | ❌ Cursor stores response in KV blob instead of streaming |
| **Our proxy (fresh sessions)** | New session with history in prompt | ✅ Works! Cursor streams for new sessions |

---

## Conclusion

The fundamental issue is that Cursor's server-side architecture expects a specific client (their CLI) that:

1. Handles `exec_server_message` synchronously
2. Stays connected to the same session
3. Can reconstruct state from KV blobs

Our OpenAI-compatible proxy bridges this by treating each request as a fresh conversation, which sidesteps the stateful session complexity entirely.

### Trade-offs

| Aspect | Fresh Sessions | Session Reuse |
|--------|---------------|---------------|
| **Reliability** | ✅ Always works | ❌ KV blob issue |
| **Latency** | Slightly higher (new session each time) | Lower (reuse connection) |
| **State consistency** | ✅ Client owns state | ❌ Server/client mismatch |
| **Implementation** | Simple | Complex |

**Recommendation**: Use fresh sessions (default). The slight latency overhead is acceptable for reliable operation.

---

## References

- `src/server.ts` - Proxy server implementation
- `src/lib/api/agent-service.ts` - Cursor Agent API client with KV blob handling
- `scripts/investigate-kv-blobs.ts` - Investigation script
- `docs/TOOL_CALLING_INVESTIGATION.md` - Detailed tool calling documentation

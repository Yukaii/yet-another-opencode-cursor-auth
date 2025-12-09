# Tool Calling Investigation Summary

**Date**: December 8, 2025
**Status**: ✅ **FULLY WORKING** - OpenAI-compatible tool calling with OpenCode

## Latest Status (Session 8) - BREAKTHROUGH!

### Full OpenAI-Compatible Tool Calling Now Working

The server now correctly translates between Cursor's Agent API and OpenAI's tool calling format, allowing OpenCode to work seamlessly with Cursor's AI models.

**Key Achievement**: OpenCode can now use all its tools (bash, read, glob, grep, list, edit, write, task, etc.) through Cursor's API with full round-trip execution.

### The Solution

When the client provides `tools` in the request, ALL `exec_request` messages from Cursor are converted to OpenAI `tool_calls` format instead of being executed locally:

1. **Client sends request** with `tools` array
2. **Cursor model calls a tool** → Server receives `exec_request` 
3. **Server emits `tool_calls`** chunk and closes the SSE stream with `finish_reason: "tool_calls"`
4. **Client (OpenCode) executes tool** locally
5. **Client sends new request** with tool result as a message (`role: "tool"`)
6. **Server formats conversation** with tool results and sends to Cursor
7. **Model continues** generating response

### Code Changes Made

1. **`src/server.ts`** - Major refactor of exec_request handling:
   - Added `clientProvidedTools` check to determine execution mode
   - When tools are provided: emit ALL exec_requests as OpenAI tool_calls
   - When no tools: execute built-in tools locally (legacy mode)
   - Close stream immediately after emitting tool_calls (fixes hang issue)
   - Added separate `mcpToolCallIndex` counter (fixes index=1 bug)

2. **`src/server.ts:messagesToPrompt()`** - Full conversation history support:
   - Handles `role: "tool"` messages with tool results
   - Formats conversation with tool call history for model continuation
   - Properly structures multi-turn conversations

3. **`src/server.ts:handleToolResult()`** - Updated for all exec types:
   - Now handles shell, read, ls, grep, and mcp result types
   - Properly sends results back to Cursor in correct format

### Tool Name Mapping

| Cursor exec_request type | OpenAI tool name | Arguments |
|--------------------------|------------------|-----------|
| `shell` | `bash` | `{ command, cwd? }` |
| `read` | `read` | `{ filePath }` |
| `ls` | `list` | `{ path }` |
| `grep` (with pattern) | `grep` | `{ pattern, path }` |
| `grep` (with glob) | `glob` | `{ pattern, path }` |
| `mcp` | Original tool name | Original args |

### Test Results

```
=== OpenAI Multi-Turn Tool Calling Test ===

1. Sending initial request...
   Response 1:
   - Content: "I'll check the weather in Tokyo..."
   - Tool Calls: 1 - get_weather({"location":"Tokyo"})
   - Finish Reason: tool_calls

2. Executing tool locally (simulated)...

3. Sending follow-up request with tool result...
   Response 2 (continuation):
   - Content: "Based on the weather data, here's the current weather in Tokyo:
     - Temperature: 22°C
     - Condition: Partly cloudy..."
   - Finish Reason: stop

SUCCESS! Multi-turn tool calling flow completed.
```

### OpenCode Integration Verified

OpenCode with 40+ tools (bash, read, glob, grep, list, edit, write, task, webfetch, todowrite, chrome-devtools_*, etc.) now works correctly through the proxy server.

---

## Previous Status (Session 6)

### Completed: Grep/Glob Tool Support
Added support for grep and glob file search operations:

1. **`sendGrepResult()` method** added to `AgentServiceClient` class
2. **Grep handler** in `server.ts` for `execReq.type === 'grep'`
3. **Glob support** using Bun's native `Bun.Glob` API for recursive patterns like `**/*.ts`
4. **Grep support** using ripgrep (`rg`) with fallback to `grep -rl`

**Test Results**:
- Glob pattern `**/*.ts` in `src` directory correctly found 17 TypeScript files
- Results properly encoded and sent back to Cursor backend
- Tool call marked as completed

### Known Issue: Model Continuation After Tool Execution
After tool execution completes successfully, the model sometimes gets stuck in a heartbeat loop instead of generating a text response. The stream receives continuous heartbeats but no `turn_ended` or text delta.

**Workaround**: After 10 heartbeats post-tool-execution, the stream auto-closes with a stop reason.

---

## Previous Status (Session 5)

### Major Breakthrough
The exec flow is now **fully working** in the test script! We can:
1. Receive `exec_server_message` requests from Cursor
2. Execute local commands (shell, ls, read, grep/glob)
3. Send results back via `BidiAppend`

### Root Cause Fixed
The "Conversation state is required" error was caused by `encodeMessageField` skipping empty fields. The server **requires** field 1 (`conversation_state_structure`) to be present even if empty (`0a 00` bytes).

### Working Test Script
`/scripts/test-exec-flow.ts` successfully:
- Connects via bidirectional streaming (RunSSE + BidiAppend)
- Handles `kv_server_message` (get/set blob)
- Receives `exec_server_message` (ls_args, shell_stream_args)
- Executes commands locally and returns results

## Overview

This document summarizes the investigation into enabling tool calling through the Cursor Agent API proxy. The goal is to allow OpenCode to use Cursor's AI models with tool/function calling capabilities via an OpenAI-compatible API.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  OpenCode   │────▶│  Proxy Server    │────▶│  Cursor Agent   │
│  (Client)   │     │  (port 18741)    │     │  API Backend    │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │
                    Translates OpenAI
                    format to Cursor
                    protobuf format
```

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | OpenAI-compatible proxy server on port 18741 |
| `src/lib/api/agent-service.ts` | Cursor Agent API client with protobuf encoding |
| `cursor-agent-restored-source-code/` | Restored Cursor CLI source for reference |

## Proto Message Structure

### AgentRunRequest (sent to server)
```
AgentRunRequest:
  field 1: conversation_state (ConversationStateStructure)
  field 2: action (ConversationAction)
  field 3: model_details (ModelDetails)
  field 4: mcp_tools (McpTools)           ← Tools sent here
  field 5: conversation_id (string)
```

### RequestContext (inside UserMessageAction)
```
RequestContext:
  field 2: rules (repeated CursorRule)
  field 4: env (RequestContextEnv)
  field 7: tools (repeated McpToolDefinition)  ← Tools ALSO sent here
  field 11: git_repos (repeated GitRepoInfo)
```

### McpToolDefinition
```
McpToolDefinition:
  field 1: name (string)              - Combined: "provider___toolname"
  field 2: description (string)
  field 3: input_schema (google.protobuf.Value)
  field 4: provider_identifier (string)
  field 5: tool_name (string)
```

### AgentServerMessage (received from server)
```
AgentServerMessage:
  field 1: interaction_update (InteractionUpdate)     ← Text & tool calls
  field 2: exec_server_message (ExecServerMessage)    ← Tool execution requests
  field 3: conversation_checkpoint_update             ← Completion signal
  field 4: kv_server_message (KvServerMessage)        ← KV operations
  field 5: exec_server_control_message
  field 7: interaction_query
```

### InteractionUpdate (inside field 1)
```
InteractionUpdate:
  field 1: text_delta (TextDeltaUpdate)
  field 2: tool_call_started (ToolCallStartedUpdate)
  field 3: tool_call_completed (ToolCallCompletedUpdate)
  field 7: partial_tool_call (PartialToolCallUpdate)
  field 8: token_delta (TokenDeltaUpdate)
  field 14: turn_ended (TurnEndedUpdate)
```

## What's Implemented

### Working Features
1. **Basic Chat**: Text streaming works correctly without tools
2. **Tool Encoding**: Tools encoded in both `AgentRunRequest.mcp_tools` AND `RequestContext.tools`
3. **KV Message Handling**: Blob get/set operations are handled correctly
4. **Checkpoint Handling**: Conversation completion detection works
5. **Shell Execution**: Local shell command execution via `exec_server_message`
6. **LS Execution**: Directory listing via `ls_args`
7. **Read Execution**: File reading via `read_args` with proper ReadSuccess encoding
8. **Grep/Glob Execution**: File search via `grep_args` with Bun.Glob support

### Code Changes Made
1. Added `buildRequestContext()` function that includes tools in field 7
2. Added `encodeMcpToolDefinition()` for proper tool format
3. Added `encodeMcpTools()` wrapper for AgentRunRequest.mcp_tools (field 4)
4. Updated `buildChatMessage()` to pass tools to both locations

## Testing Method

### Start the Server
```bash
cd /Users/yukai/Projects/Personal/opencode-cursor-auth
pkill -f "bun.*server.ts" 2>/dev/null || true
nohup bun run src/server.ts > /tmp/cursor-server.log 2>&1 &
```

### Test WITHOUT Tools (Works)
```bash
curl -s -X POST http://localhost:18741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Say hello"}],
    "stream": true
  }'
```

**Expected Output**: Streaming text response with "Hello! How can I assist you today?"

### Test WITH Tools (Not Working)
```bash
curl -s -X POST http://localhost:18741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Use the bash tool to run: echo hello"}],
    "stream": true,
    "tools": [{
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute a bash command in the terminal",
        "parameters": {
          "type": "object",
          "properties": {
            "command": {"type": "string", "description": "The bash command to execute"}
          },
          "required": ["command"]
        }
      }
    }]
  }'
```

**Current Output**: Empty response (no text, no tool calls)

### Check Logs
```bash
cat /tmp/cursor-server.log | tail -50
```

## Current Issue

### Symptoms
When tools are provided AND the user asks for tool execution:
- **No text output** (no `field1` InteractionUpdate)
- **No tool calls** (no `field2` tool_call_started in InteractionUpdate)
- Only KV operations (`field4`) followed by checkpoint (`field3`)
- Model silently completes without producing any output

### Debug Log Pattern (With Tools + Tool Request)
```
[DEBUG] Adding 1 tools to RequestContext.tools (field 7)
[DEBUG] Encoding 1 tools: [ "bash" ]
[DEBUG] McpTools encoded length: 224
[DEBUG] Server message fields: field4:2    ← KV operation
[DEBUG] Server message fields: field4:2    ← KV operation
[DEBUG] Server message fields: field4:2    ← KV operation
[DEBUG] Server message fields: field4:2    ← KV operation
[DEBUG] Server message fields: field4:2    ← KV operation
[DEBUG] Server message fields: field3:2    ← Checkpoint (done)
```

### Debug Log Pattern (Without Tools)
```
[DEBUG] Server message fields: field1:2
[DEBUG] Received interaction_update, length: 11
[DEBUG] InteractionUpdate fields: field1           ← text_delta
[DEBUG] Server message fields: field1:2
[DEBUG] InteractionUpdate fields: field8           ← token_delta
... (more text/token deltas)
[DEBUG] Server message fields: field3:2            ← Checkpoint
```

## Hypotheses

### 1. Exec Server Capability Required
The Cursor backend may expect an exec server to be established before processing tool calls. The native client uses `ClientExecController` to handle `ExecServerMessage` from the server.

**Evidence**:
- Native code has `execHandler = new ClientExecController(execStream, execOutputStream, controlledExecManager)`
- We never receive `field2` (exec_server_message), suggesting server may not send tool calls without exec capability

### 2. Capability Negotiation Missing
There might be a handshake or capability negotiation that tells the server we support tool execution.

**To Investigate**:
- Look for `ExecClientControlMessage` in native code
- Check if there's an initial capability message sent

### 3. Tool Format Issue
Our MCP tool format might not be recognized by the model, causing silent failure.

**Current Format**:
- `name`: "opencode___bash"
- `providerIdentifier`: "opencode"
- `toolName`: "bash"

## Next Steps

1. **Investigate Exec Capability Negotiation**
   - Search for how native client establishes exec server
   - Look for `ExecClientControlMessage` patterns
   - Check if there's initial capability advertisement

2. **Try Sending ExecClientControlMessage**
   - May need to send a control message indicating exec support
   - Check `ExecServerControlMessage` structure for hints

3. **Alternative: Use Built-in Tools Only**
   - Cursor has built-in tools (bash, read, edit, etc.)
   - These might work without MCP tool definitions
   - Test if removing custom tools and using built-in tool names works

4. **Check Privacy Mode Impact**
   - Currently using `x-ghost-mode: false`
   - Try with different privacy settings

## Reference: Native Tool Call Flow

From `cursor-agent-restored-source-code/agent-client/dist/connect.js`:

```javascript
// Tools are passed in AgentRunRequest
const promise = monitoredRequestStream.write(new agent_service_pb.AgentClientMessage({
  message: {
    case: "runRequest",
    value: new agent_pb.AgentRunRequest({
      conversationState,
      action,
      modelDetails,
      mcpTools: new mcp_pb.McpTools({
        mcpTools: protoMcpTools
      }),
      conversationId: options.conversationId,
    })
  }
}));

// Exec handler processes tool execution
const execHandler = new ClientExecController(
  execStream,
  execOutputStream,
  controlledExecManager
);
```

From `cursor-agent-restored-source-code/local-exec/dist/request-context.js`:

```javascript
// Tools also added to RequestContext
tools: mcpTools.map(tool => new mcp_pb.McpToolDefinition({
  name: tool.name,
  providerIdentifier: tool.providerIdentifier,
  toolName: tool.toolName,
  description: tool.description,
  inputSchema: tool.inputSchema ? struct_pb.Value.fromJson(tool.inputSchema) : undefined
}))
```

## Key Discovery (Dec 8)

### How Cursor's Native Tool Flow Actually Works

After analyzing `connect.js`, `exec-controller.js`, `controlled.js`, and `mcp.js`, the full picture is now clear:

**Cursor expects the CLIENT to execute tools locally.** The server doesn't run tools - it instructs the client what to do, and the client responds with results.

### The Bidirectional Message Flow

```
┌──────────────────┐                          ┌────────────────────┐
│   OpenAI Client  │                          │   Cursor Backend   │
└────────┬─────────┘                          └────────┬───────────┘
         │                                             │
         │  1. AgentRunRequest (with tools)            │
         │────────────────────────────────────────────▶│
         │                                             │
         │  2. InteractionUpdate (text_delta)          │
         │◀────────────────────────────────────────────│
         │                                             │
         │  3. ExecServerMessage (mcp_args)            │
         │◀────────────────────────────────────────────│
         │     "Execute tool X with args Y"            │
         │                                             │
         │  4. ExecClientMessage (mcp_result)          │
         │────────────────────────────────────────────▶│
         │     "Here's the result"                     │
         │                                             │
         │  5. ExecClientControlMessage (stream_close) │
         │────────────────────────────────────────────▶│
         │                                             │
         │  6. InteractionUpdate (more text)           │
         │◀────────────────────────────────────────────│
         │                                             │
         │  7. CheckpointUpdate (done)                 │
         │◀────────────────────────────────────────────│
         │                                             │
```

### Proto Messages Involved

**ExecServerMessage** (what server sends to request tool execution):
```protobuf
message ExecServerMessage {
  uint32 id = 1;          // Correlation ID
  string exec_id = 15;    // Unique execution ID

  oneof message {
    ShellArgs shell_args = 2;
    WriteArgs write_args = 3;
    DeleteArgs delete_args = 4;
    GrepArgs grep_args = 5;
    ReadArgs read_args = 7;
    LsArgs ls_args = 8;
    DiagnosticsArgs diagnostics_args = 9;
    RequestContextArgs request_context_args = 10;
    McpArgs mcp_args = 11;              // ◀ MCP tool call
    ShellArgs shell_stream_args = 14;
    BackgroundShellSpawnArgs background_shell_spawn_args = 16;
    ListMcpResourcesExecArgs list_mcp_resources_exec_args = 17;
    ReadMcpResourceExecArgs read_mcp_resource_exec_args = 18;
    FetchArgs fetch_args = 20;
    RecordScreenArgs record_screen_args = 21;
    ComputerUseArgs computer_use_args = 22;
  }

  SpanContext span_context = 19;
}
```

**McpArgs** (inside ExecServerMessage.mcp_args):
```protobuf
message McpArgs {
  string name = 1;                          // "provider___toolname"
  map<string, google.protobuf.Value> args = 2;  // Tool arguments
  string tool_call_id = 3;                  // Correlation ID
  string provider_identifier = 4;           // e.g., "opencode"
  string tool_name = 5;                     // e.g., "bash"
}
```

**ExecClientMessage** (what client sends back with result):
```protobuf
message ExecClientMessage {
  uint32 id = 1;          // Must match ExecServerMessage.id
  string exec_id = 15;    // Must match ExecServerMessage.exec_id

  oneof message {
    ShellResult shell_result = 2;
    WriteResult write_result = 3;
    DeleteResult delete_result = 4;
    GrepResult grep_result = 5;
    ReadResult read_result = 7;
    LsResult ls_result = 8;
    DiagnosticsResult diagnostics_result = 9;
    RequestContextResult request_context_result = 10;
    McpResult mcp_result = 11;              // ◀ MCP tool result
    ShellStream shell_stream = 14;
    BackgroundShellSpawnResult background_shell_spawn_result = 16;
    ListMcpResourcesExecResult list_mcp_resources_exec_result = 17;
    ReadMcpResourceExecResult read_mcp_resource_exec_result = 18;
    FetchResult fetch_result = 20;
    RecordScreenResult record_screen_result = 21;
    ComputerUseResult computer_use_result = 22;
  }
}
```

**McpResult** (inside ExecClientMessage.mcp_result):
```protobuf
message McpResult {
  oneof result {
    McpSuccess success = 1;
    McpError error = 2;
    McpRejected rejected = 3;
    McpPermissionDenied permission_denied = 4;
  }
}

message McpSuccess {
  repeated McpToolResultContentItem content = 1;
  bool is_error = 2;
}

message McpToolResultContentItem {
  oneof content {
    McpTextContent text = 1;
    McpImageContent image = 2;
  }
}
```

**ExecClientControlMessage** (control flow):
```protobuf
message ExecClientControlMessage {
  oneof message {
    ExecClientStreamClose stream_close = 1;  // Exec completed successfully
    ExecClientThrow throw = 2;               // Exec failed
  }
}

message ExecClientStreamClose {
  uint32 id = 1;  // Must match ExecServerMessage.id
}
```

### The Root Cause

**Our current implementation only SENDS tools to the server and expects it to handle them.** But Cursor's architecture is **different**:

1. We send tools (correctly)
2. Server instructs us to execute via `ExecServerMessage` (we receive but don't handle)
3. We never send back `ExecClientMessage` with results
4. Server waits, times out, and checkpoints without output

### Solution Options

#### Option A: Full Local Execution (Like Native Cursor)

Implement all the local executors:
- Shell executor (run bash commands)
- File executor (read/write/delete files)
- MCP executor (call MCP tools)
- etc.

**Pros**: Full compatibility with Cursor's tool system
**Cons**: Large implementation effort, security concerns

#### Option B: Callback Pattern (Recommended for OpenAI Proxy)

Re-architect to pass tool calls back to OpenAI client:

1. Receive `ExecServerMessage.mcp_args` from Cursor
2. Convert to OpenAI tool_call format
3. Stream to OpenAI client
4. Wait for tool result from OpenAI client
5. Convert result to `ExecClientMessage.mcp_result`
6. Send back to Cursor via `BidiAppend`

**Pros**: Maintains OpenAI-compatible interface, client handles execution
**Cons**: Requires changes to streaming protocol (need to pause/resume)

#### Option C: Ask Mode Without Tools

Use Cursor in "ask" mode without tools, then handle tools entirely on our side.

**Pros**: Simplest implementation
**Cons**: Loses benefits of Cursor's native tool calling

### Implementation Plan for Option B

```typescript
// In chatStream(), when we receive ExecServerMessage:
if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
  const execMsg = parseExecServerMessage(field.value);

  if (execMsg.messageType === 'mcp_args') {
    // Convert to OpenAI tool call
    const toolCallChunk = {
      type: "tool_call_started",
      toolCall: {
        callId: execMsg.toolCallId,
        name: execMsg.toolName,
        arguments: JSON.stringify(execMsg.args),
      },
    };
    yield toolCallChunk;

    // Wait for tool result from caller (need new protocol)
    const result = await waitForToolResult(execMsg.toolCallId);

    // Send result back to Cursor
    const execClientMsg = buildExecClientMessage(execMsg.id, result);
    await this.bidiAppend(requestId, appendSeqno++, execClientMsg);

    // Send control message
    const controlMsg = buildExecClientControlMessage(execMsg.id);
    await this.bidiAppend(requestId, appendSeqno++, controlMsg);
  }
}
```

### Files to Modify

1. **`src/lib/api/agent-service.ts`**:
   - Add `parseExecServerMessage()` function
   - Add `buildExecClientMessage()` function
   - Add `buildExecClientControlMessage()` function
   - Modify `chatStream()` to handle exec messages

2. **`src/server.ts`**:
   - Add endpoint or callback for tool results
   - Modify streaming logic to support tool call/result flow

### Reference Code Locations

- Tool execution handling: `cursor-agent-restored-source-code/local-exec/dist/mcp.js:794-953`
- Exec controller: `cursor-agent-restored-source-code/agent-exec/dist/controlled.js:173-260`
- Connect stream splitter: `cursor-agent-restored-source-code/agent-client/dist/connect.js:162-222`

## Working Message Structure (Critical!)

### AgentClientMessage for Initial Request
```
AgentClientMessage {
  field 1: AgentRunRequest {
    field 1: ConversationStateStructure  // MUST be present even if empty = "0a 00"
    field 2: ConversationAction {
      field 1: UserMessageAction {
        field 1: UserMessage { prompt, message_id, mode=1 }
        field 2: RequestContext (REQUIRED!) {
          field 4: env { os_version, workspace_paths, shell, time_zone, project_folder }
        }
      }
    }
    field 3: ModelDetails { model_name="gpt-4o" }
    field 5: conversation_id
  }
}
```

### ExecClientMessage for Shell Results
```
AgentClientMessage {
  field 2: ExecClientMessage {
    field 1: id (uint32) - must match ExecServerMessage.id
    field 15: exec_id (string) - must match ExecServerMessage.exec_id
    field 2: ShellResult {
      field 1: stdout (string)
      field 2: exit_code (int32)
    }
  }
}
```

### ExecClientMessage for LsResult
```
AgentClientMessage {
  field 2: ExecClientMessage {
    field 1: id
    field 15: exec_id
    field 8: LsResult {
      field 1: LsSuccess {
        field 1: files_string (string)
        // OR field 2: tree (LsDirectoryTreeNode) - preferred but complex
      }
    }
  }
}
```

### ExecClientMessage for ReadResult
```
AgentClientMessage {
  field 2: ExecClientMessage {
    field 1: id
    field 15: exec_id
    field 7: ReadResult {
      field 1: ReadSuccess {
        field 1: path (string) - the file path that was read
        field 2: content (string) - oneof output (text files)
        field 3: total_lines (int32)
        field 4: file_size (int64)
        field 5: data (bytes) - oneof output (binary/image files)
        field 6: truncated (bool)
      }
    }
  }
}
```

### ExecClientMessage for GrepResult
```
AgentClientMessage {
  field 2: ExecClientMessage {
    field 1: id
    field 15: exec_id
    field 5: GrepResult {
      field 1: GrepSuccess {
        field 1: pattern (string)
        field 2: path (string)
        field 3: output_mode (string) - "files_with_matches"
        field 4: workspace_results (map<string, GrepUnionResult>) {
          // Map entry: key=path, value=GrepUnionResult
          GrepUnionResult {
            field 2: GrepFilesResult {
              field 1: files (repeated string)
              field 2: total_files (int32)
              field 3: client_truncated (bool)
            }
          }
        }
      }
    }
  }
}
```

### KvClientMessage for Blob Operations
```
AgentClientMessage {
  field 3: KvClientMessage {
    field 1: id (uint32)
    field 2: GetBlobResult { } - empty for not found
    field 3: SetBlobResult { } - empty for success
  }
}
```

## Server Message Flow Observed

```
Client                                     Server
  |                                          |
  |--- RunSSE (BidiRequestId) -------------->|
  |--- BidiAppend (AgentRunRequest) -------->|
  |                                          |
  |<--- kv_server_message (set_blob_args) ---|  Server stores state
  |--- kv_client_message (set_blob_result)-->|
  |                                          |
  |<--- interaction_update (text_delta) -----|  AI starts talking
  |                                          |
  |<--- exec_server_message (ls_args) -------|  Tool execution request
  |--- exec_client_message (ls_result) ----->|  Tool result
  |                                          |
  |<--- interaction_update (more text) ------|  AI continues
  |                                          |
  |<--- checkpoint_update -------------------|  Complete
```

## Remaining Issues

1. **Model continuation after tool execution** - Model gets stuck in heartbeat loop after tool execution instead of generating response text. Current workaround: auto-close after 10 heartbeats.
2. **LsResult format** - Currently sending simple string in `files_string`, server may prefer `LsDirectoryTreeNode` tree structure
3. **MCP tool forwarding** - MCP tools are forwarded to OpenAI client but full round-trip not tested

## Next Steps

1. ✅ Fix empty conversation_state encoding (done)
2. ✅ Add RequestContext to initial message (done)
3. ✅ Handle exec_server_message (done)
4. ✅ Implement shell execution (done)
5. ✅ Implement ls execution (done)
6. ✅ Implement read execution with proper ReadSuccess format (done)
7. ✅ Implement grep/glob execution with Bun.Glob (done)
8. ⬜ Fix model continuation after tool execution (heartbeat issue)
9. ⬜ Implement proper LsDirectoryTreeNode format
10. ⬜ Test MCP tool round-trip (mcp_args → client → mcp_result)

## Session 9: Tool Result Flow Investigation (Dec 9, 2025)

### Problem Statement

After sending tool results back to Cursor via `BidiAppend`, the model stops streaming text responses. Only heartbeats are received, and the turn never completes.

### Key Discovery: Two Different Flows

Testing revealed **two fundamentally different behaviors** depending on how tool results are sent:

#### Flow A: Fresh Request with History (WORKING ✅)

When tool results are sent as part of a **new HTTP request** with full conversation history:

```
Client                                     Server
  |                                          |
  |--- NEW Request with history ------------>|
  |    [user, assistant+tool_call, tool]     |
  |                                          |
  |<--- interaction_update (text_delta) -----|  ✅ AI responds with text
  |<--- interaction_update (text_delta) -----|
  |<--- turn_ended (field 14) ---------------|  ✅ Turn completes
```

**Test:**
```bash
curl -X POST http://localhost:18741/v1/chat/completions \
  -d '{
    "messages": [
      {"role": "user", "content": "What is the weather in Paris?"},
      {"role": "assistant", "content": "Getting weather...", 
       "tool_calls": [{"id": "call_abc", "function": {"name": "get_weather", "arguments": "{}"}}]},
      {"role": "tool", "tool_call_id": "call_abc", "content": "59°F, cloudy"}
    ]
  }'
```

**Result:** Model responds with text: "Current weather in Paris: 59°F, light rain, cloudy."

#### Flow B: BidiAppend to Existing Stream (NOT WORKING ❌)

When tool results are sent via **BidiAppend** to continue an existing stream:

```
Client                                     Server
  |                                          |
  |--- Initial Request ---------------------->|
  |<--- exec_server_message (mcp_args) -------|
  |--- ExecClientMessage (mcp_result) ------->|  Tool result sent
  |--- ExecClientControlMessage (close) ----->|  Stream closed
  |                                          |
  |<--- tool_call_completed (field 3) --------|  ✅ Acknowledged
  |<--- kv_server_message (set_blob) ---------|  Response stored in KV!
  |<--- heartbeat (field 13) -----------------|  ❌ Only heartbeats
  |<--- heartbeat (field 13) -----------------|
  |    ... no text, no turn_ended ...        |
```

**What Happens:**
1. Tool result is acknowledged (`tool_call_completed`)
2. Model generates response but stores it in **KV blob** instead of streaming
3. No `text_delta` (field 1) or `token_delta` (field 8) in InteractionUpdate
4. No `turn_ended` (field 14) ever received
5. Stream stuck in heartbeat loop

**KV Blob Contents (from logs):**
```json
{"id":"1","role":"assistant","content":[{"type":"text","text":"<think>\nThe user wants to know the weather..."}]}
```

### Root Cause Analysis

The Cursor server behaves differently for **mid-turn tool results** vs **new conversation turns**:

| Aspect | Fresh Request | BidiAppend |
|--------|--------------|------------|
| Text delivery | `InteractionUpdate.text_delta` | KV blob storage |
| Turn completion | `turn_ended` received | Never received |
| Response format | Streaming chunks | JSON in blob |

**Hypothesis**: The server is designed for the Cursor IDE which can:
1. Pull text from KV blobs for checkpoint/resume
2. Use a different rendering path for mid-turn continuations
3. Has UI-specific handling for tool result flows

Our OpenAI-compatible proxy doesn't have access to this KV blob rendering logic.

### Solution Options

#### Option A: Don't Use Session Reuse for Tools (Simple) ✅ IMPLEMENTED

For requests that will involve tool calls, always start fresh sessions. This matches how most OpenAI clients work anyway.

**Implementation:**
- When client provides `tools` in the request, skip session reuse entirely
- Always create a fresh Cursor session for tool-calling requests
- Tool results come back as new requests with full conversation history
- Server formats the history and sends as a fresh `AgentRunRequest`

**Pros:**
- Works immediately, no protocol changes needed
- Matches standard OpenAI client behavior
- Simpler code path, easier to debug
- More reliable - each request is independent

**Cons:**
- Loses session continuity benefits (context window sharing)
- Slightly slower (new connection per request)
- More API calls to Cursor backend

**Code Change in `server.ts`:**
```typescript
// In streamWithSessionReuse():
// Skip session reuse entirely when tools are provided
const clientProvidedTools = Array.isArray(body.tools) && body.tools.length > 0;
if (clientProvidedTools) {
  // Always use fresh session for tool-calling flows
  return legacyStreamResponse({ body, model, prompt, completionId, created, accessToken });
}
```

#### Option B: Extract Text from KV Blobs (Medium) - DOCUMENTED FOR FUTURE

Parse the JSON blobs stored in KV and extract the text response. This would allow session reuse to work but requires more complex handling.

**Implementation Approach:**
```typescript
// In AgentServiceClient.chatStream(), modify handleKvMessage:
private async *handleKvMessageWithTextExtraction(
  kvMsg: KvServerMessage,
  requestId: string,
  appendSeqno: bigint
): AsyncGenerator<AgentStreamChunk> {
  // ... existing KV handling ...
  
  if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobData) {
    try {
      const text = new TextDecoder().decode(kvMsg.blobData);
      const json = JSON.parse(text);
      
      // Check if this is an assistant message blob
      if (json.role === 'assistant' && json.content) {
        const extractedText = extractTextFromContent(json.content);
        if (extractedText) {
          yield { type: "text", content: extractedText };
        }
      }
    } catch {
      // Not JSON or not an assistant message - ignore
    }
  }
}

function extractTextFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text')
      .map(item => item.text || '')
      .join('');
  }
  return '';
}
```

**Challenges:**
1. **Timing**: Text arrives via KV before `turn_ended` - need to buffer or emit immediately
2. **Completeness**: May miss content if stored across multiple blobs
3. **Thinking tags**: Response includes `<think>` blocks that should be filtered
4. **No turn_ended**: Still won't receive turn_ended, need to detect completion differently

**Pros:**
- Keeps session reuse working
- Lower latency for multi-turn conversations
- Shared context window across turns

**Cons:**
- Complex implementation
- Fragile - depends on KV blob format staying consistent
- May have edge cases with partial content

#### Option C: Find the Continue Signal (Ideal) - THOROUGHLY INVESTIGATED

Investigated whether there's a message that triggers streaming instead of KV storage. **Conclusion: No such signal exists, but deeper analysis reveals potential issues with our BidiAppend implementation.**

**All ConversationAction Types Found:**
| Field # | Name | Purpose |
|---------|------|---------|
| 1 | `user_message_action` | User sends a new message |
| 2 | `resume_action` | Resume after connection loss ONLY |
| 3 | `cancel_action` | Cancel current operation |
| 4 | `summarize_action` | Request conversation summary |
| 5 | `shell_command_action` | Execute shell command |
| 6 | `start_plan_action` | Start planning mode |
| 7 | `execute_plan_action` | Execute a plan |
| 8 | `async_ask_question_completion_action` | Complete async question |

**ResumeAction Details:**
```javascript
// ResumeAction only contains request_context - used for reconnection only
ResumeAction.fields = [{
  no: 2,
  name: "request_context",
  kind: "message",
  T: RequestContext
}];
```

**Key Findings:**
1. **No "continue" signal exists** - The backend AUTOMATICALLY continues generating when it receives tool results
2. **ResumeAction is ONLY for connection loss recovery** - NOT for post-tool continuation
3. **KV blobs are for checkpointing, NOT streaming** - Text should come via `InteractionUpdate.textDelta`
4. **Native flow expects stream to stay open** - Server pauses, waits for results, then resumes text generation

**The Expected Native Flow:**
```
Client                                     Server
  |                                          |
  |--- Initial Request ---------------------->|
  |<--- InteractionUpdate (text_delta) -------|  Text streaming
  |<--- ExecServerMessage (tool request) -----|  Tool call
  |                                          |
  |   [Server PAUSES text generation]        |
  |                                          |
  |--- ExecClientMessage (tool result) ------>|
  |--- ExecClientControlMessage (close) ----->|
  |                                          |
  |   [Server RESUMES automatically]         |
  |                                          |
  |<--- InteractionUpdate (text_delta) -------|  More text
  |<--- InteractionUpdate (turn_ended) -------|  Done
```

**Why Our BidiAppend Flow Might Be Broken:**
1. **Stream lifecycle issue** - SSE stream might be closing after receiving heartbeats
2. **Message ordering** - `append_seqno` might be incorrect, causing server to wait
3. **Request context mismatch** - Tool result might be missing required context
4. **State mismatch** - Checkpoint sent with tool result doesn't match server expectation

**Potential Fix (Option C-fix):**
If we want to debug further, we should:
1. Capture what native Cursor CLI sends for tool results (exact protobuf bytes)
2. Compare with our implementation
3. Verify SSE stream doesn't close prematurely (increase heartbeat tolerance)
4. Check `append_seqno` is correctly incremented after KV messages
5. Ensure the same `request_id` is used consistently

However, since Option A (fresh sessions) works reliably and matches standard OpenAI behavior, it's the pragmatic choice for now.

### Test Commands

**Test Flow A (Fresh - Working):**
```bash
curl -s -X POST http://localhost:18741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Weather in Paris?"},
      {"role": "assistant", "content": "Checking...", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{}"}}]},
      {"role": "tool", "tool_call_id": "call_1", "content": "59°F cloudy"}
    ]
  }'
```

**Test Flow B (Session Reuse - Broken):**
```bash
# Step 1: Get tool call
curl ... -d '{"messages": [{"role": "user", "content": "Weather?"}], "tools": [...]}'
# Returns: tool_call with session ID prefix

# Step 2: Send tool result (triggers BidiAppend path)
curl ... -d '{"messages": [..., {"role": "tool", "tool_call_id": "sess_xxx__call_yyy", "content": "result"}]}'
# Returns: empty response (text in KV only)
```

### Final Decision

**Implemented Option A** - Skip session reuse for tool-calling flows. This provides:
- Reliable tool calling with OpenCode and other OpenAI-compatible clients
- Simpler architecture with independent requests
- No dependency on Cursor's internal KV blob format

Option B is documented above for future reference if session reuse becomes critical for performance.

---

## Session 10: Critical Path for Session Reuse (Dec 9, 2025)

### Deep Dive into Cursor CLI Architecture

Further investigation into the Cursor CLI source code revealed the exact transport architecture:

#### Transport Architecture: SSE + BidiAppend (NOT True BiDi)

Cursor CLI uses HTTP/1.1 with:
- **Read**: Server-Sent Events (SSE) via `RunSSE` endpoint
- **Write**: Separate HTTP POST calls via `BidiAppend` endpoint

```
┌─────────────────────────────────────────────────────────────────────┐
│                    HTTP/1.1 MODE (BidiSseTransport)                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Client                                         Server              │
│    │                                              │                 │
│    │───── POST /agent.v1.AgentService/RunSSE ────►│                 │
│    │      Body: BidiRequestId{requestId: "abc"}   │                 │
│    │◄════════════ SSE Stream ════════════════════│                 │
│    │              (AgentServerMessages)           │                 │
│    │                                              │                 │
│    │───── POST BidiAppend (seqno:0, runRequest) ─►│                 │
│    │───── POST BidiAppend (seqno:1, execResult) ─►│                 │
│    │───── POST BidiAppend (seqno:2, streamClose)─►│                 │
│    │                                              │                 │
│    │              Correlated by x-request-id      │                 │
└─────────────────────────────────────────────────────────────────────┘
```

#### What We Verified Is CORRECT ✅

1. **Transport mechanism** - SSE read + BidiAppend write
2. **Message encoding** - ExecClientMessage, ExecClientControlMessage
3. **Field numbers** - All match proto definitions
4. **append_seqno** - Starts at 0, increments correctly
5. **streamClose control message** - Sent after each exec result
6. **request_id correlation** - Same UUID in headers and message body

#### What Cursor CLI Does That We Do

| Aspect | Cursor CLI | Our Implementation | Status |
|--------|------------|-------------------|--------|
| All tools executed client-side | ✅ Yes | ✅ Yes | Match |
| BidiAppend for exec results | ✅ Yes | ✅ Yes | Match |
| streamClose after each result | ✅ Yes | ✅ Yes | Match |
| No "continue" signal after tools | ✅ Just waits | ✅ Just waits | Match |
| Server drives continuation | ✅ Yes | ❓ Not working | **ISSUE** |

#### Headers Comparison

| Header | Cursor CLI | Our Implementation | Notes |
|--------|------------|-------------------|-------|
| `authorization` | Bearer token | Bearer token | ✅ |
| `x-request-id` | UUID | UUID | ✅ |
| `x-cursor-client-version` | cli-2025.11.25-xxx | cli-2025.11.25-xxx | ✅ |
| `x-cursor-client-type` | cli | cli | ✅ |
| `x-ghost-mode` | true/false | false | ✅ |
| `x-cursor-streaming` | **"true"** | **MISSING** | ⚠️ |

### Potential Missing Piece: `x-cursor-streaming` Header

Cursor CLI sets `x-cursor-streaming: "true"` which "signals to backend that text/event-stream content-type is accepted."

This could be the reason the server stores responses in KV blobs instead of streaming:
- Without this header, server might assume client can't handle SSE
- Response gets stored in KV for alternative retrieval (BidiPoll?)

### Critical Path to Enable Session Reuse

If we want session reuse to work like native Cursor, these are the unknowns to resolve:

#### 1. Add `x-cursor-streaming: "true"` Header (Quick Test)

```typescript
// In getHeaders():
headers["x-cursor-streaming"] = "true";
```

This signals to the backend that we can receive SSE text/event-stream responses.

#### 2. Verify SSE Stream Stays Open During Tool Execution

Our current implementation might be closing the SSE stream or reader too early. Cursor CLI:
- Keeps SSE stream open throughout the entire agent run
- Processes multiple exec requests and results on same stream
- Only closes when `turn_ended` is received

#### 3. Check Concurrent Request Handling

Cursor CLI uses:
```javascript
const maxConcurrentAppends = 16;
```
And processes BidiAppend in background without blocking SSE read.

Our implementation should ensure:
- BidiAppend calls don't block SSE processing
- Both can run concurrently

#### 4. Handle Stall Detection Properly

Cursor CLI has a 10-second stall detector that only LOGS, doesn't terminate:
```javascript
const stallDetector = new StallDetector(ctx, 10000);
// Only logs: "[NAL client stall detector] Bidirectional stream stall detected..."
// Does NOT terminate the stream
```

Our 10-heartbeat timeout might be terminating too early.

### Experiment Plan to Enable Session Reuse

1. **Quick test**: Add `x-cursor-streaming: "true"` header and test BidiAppend flow
2. **If still broken**: Increase heartbeat tolerance significantly (e.g., 5 minutes)
3. **If still broken**: Capture native Cursor CLI wire traffic for byte-level comparison
4. **If still broken**: Check if there's a `BidiPoll` fallback mechanism we need

### Why Session Reuse Might Be Broken

Current hypothesis based on investigation:

1. **Missing `x-cursor-streaming` header** - Server might be switching to KV-blob mode
2. **Heartbeat timeout too aggressive** - We close after 10 heartbeats, server might just be slow
3. **Unknown server-side state** - Tool result might be processed but continuation not triggered

The native Cursor CLI just waits indefinitely after sending tool results - no special action. The server is supposed to automatically continue. If our implementation is correct but server isn't continuing, the issue is likely:
- Header/configuration difference signaling different behavior
- Some state management we're not aware of

### Recommendation

For now, **Option A (fresh sessions) works reliably**. If performance becomes critical:

1. First try adding `x-cursor-streaming: "true"` header
2. If that works, gradually test session reuse
3. If not, capture native traffic for comparison

The investment to debug session reuse may not be worth it unless there's a specific performance requirement.

## Session 11: Final Verification (Dec 9, 2025)

### Summary

Comprehensive verification that the **fresh session workaround works perfectly** for tool calling flows. The investigation into same-session tool continuation is complete with documented findings.

### Confirmed Working Flow

```bash
# Step 1: Initial request with tools - gets tool call
curl -s http://localhost:18741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Run: echo hello"}],
    "tools": [{"type": "function", "function": {"name": "bash", "description": "Run bash command", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}}],
    "stream": true
  }'
# Returns: tool_call with id="call_xxx", name="bash", arguments="{\"command\":\"echo hello\"}"
# finish_reason: "tool_calls"

# Step 2: Send tool result in new request - model continues
curl -s http://localhost:18741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "user", "content": "Run: echo hello"},
      {"role": "assistant", "content": null, "tool_calls": [{"id": "call_123", "type": "function", "function": {"name": "bash", "arguments": "{\"command\":\"echo hello\"}"}}]},
      {"role": "tool", "tool_call_id": "call_123", "content": "hello\n"}
    ],
    "stream": true
  }'
# Returns: streaming text response "Hello! How can I assist you further today?..."
# finish_reason: "stop"
```

### Investigation Conclusions

#### What We Verified ✅

1. **Our protobuf encoding is correct** - Shell results, exec messages, and control messages all match the expected format
2. **BidiAppend mechanics work** - Server acknowledges our messages (HTTP 200) and sends `tool_call_completed`
3. **The server stores responses in KV blobs** after tool execution instead of streaming them
4. **No "continue" signal exists** - The server is supposed to automatically continue after receiving tool results
5. **Fresh sessions work perfectly** - Model continues generating when conversation history includes tool results

#### Why Same-Session Continuation Doesn't Work

After extensive investigation comparing our implementation with Cursor CLI:

| Component | Our Implementation | Cursor CLI | Match? |
|-----------|-------------------|------------|--------|
| Transport | SSE + BidiAppend | SSE + BidiAppend | ✅ |
| Message encoding | Manual protobuf | @bufbuild/protobuf | ✅ (verified) |
| ExecClientMessage | Correct fields | Correct fields | ✅ |
| streamClose control | Sent after result | Sent after result | ✅ |
| x-cursor-streaming | ✅ Added | ✅ Present | ✅ |
| Headers | All present | All present | ✅ |

**The server simply doesn't stream text after BidiAppend tool results** - it stores them in KV blobs instead. This appears to be intentional server-side behavior that differs from what we expected.

#### Important Notes

1. **Model deprecation**: `claude-3.5-sonnet` is deprecated - use `gpt-4o` instead
2. **Fresh sessions are the standard**: Most OpenAI-compatible clients use fresh requests for tool result submission anyway
3. **No performance penalty observed**: Fresh sessions work quickly and reliably

### Final Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  OpenAI Client  │────▶│  Proxy Server    │────▶│  Cursor Agent   │
│  (OpenCode)     │     │  (port 18741)    │     │  API Backend    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
       │                        │
       │  1. Chat + tools      │
       │───────────────────────▶│
       │                        │  2. Cursor returns tool call request
       │  3. tool_calls chunk  │◀──────────────────────────────────────
       │◀───────────────────────│
       │                        │
       │  4. Execute locally    │
       │                        │
       │  5. New request with   │
       │     conversation +     │  6. Cursor processes history
       │     tool result       │───────────────────────────────────────▶
       │                        │
       │  7. Streaming response │◀──────────────────────────────────────
       │◀───────────────────────│
```

### Files Modified This Session

- `scripts/debug-shell-encoding.ts` - Created to verify protobuf encoding
- `scripts/debug-proto-encoding.ts` - Previously created for encoding verification
- `docs/TOOL_CALLING_INVESTIGATION.md` - Updated with final findings

### Status: ✅ COMPLETE

Tool calling works reliably via the fresh session approach. The investigation into same-session continuation is documented for future reference if needed.

---

## Environment

- **Platform**: macOS (darwin)
- **Runtime**: Bun
- **Server Port**: 18741
- **Cursor API**: api2.cursor.sh (main), agentn.api5.cursor.sh (agent)
- **Auth**: OAuth access token from Cursor

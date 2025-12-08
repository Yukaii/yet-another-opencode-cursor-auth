# Tool Calling Investigation Summary

**Date**: December 8, 2025  
**Status**: ✅ Tool execution working (shell, ls, read, grep/glob) - Model continuation issue pending

## Latest Status (Session 6)

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

## Environment

- **Platform**: macOS (darwin)
- **Runtime**: Bun
- **Server Port**: 18741
- **Cursor API**: api2.cursor.sh (main), agentn.api5.cursor.sh (agent)
- **Auth**: OAuth access token from Cursor

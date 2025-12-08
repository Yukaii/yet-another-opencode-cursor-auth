/**
 * Cursor Agent Service Client
 * 
 * Implements the AgentService API for chat functionality.
 * Uses the BidiSse pattern:
 * - RunSSE (server-streaming) to receive responses
 * - BidiAppend (unary) to send client messages
 * 
 * Proto structure:
 * AgentClientMessage:
 *   field 1: run_request (AgentRunRequest)
 *   field 2: exec_client_message (ExecClientMessage)
 *   field 3: kv_client_message (KvClientMessage)
 *   field 4: conversation_action (ConversationAction)
 *   field 5: exec_client_control_message
 *   field 6: interaction_response
 * 
 * AgentServerMessage:
 *   field 1: interaction_update (InteractionUpdate)
 *   field 2: exec_server_message (ExecServerMessage)
 *   field 3: conversation_checkpoint_update (completion signal)
 *   field 4: kv_server_message (KvServerMessage)
 *   field 5: exec_server_control_message
 *   field 7: interaction_query
 * 
 * InteractionUpdate.message:
 *   field 1: text_delta
 *   field 4: thinking_delta
 *   field 8: token_delta
 *   field 13: heartbeat
 *   field 14: turn_ended
 */

import { randomUUID } from "node:crypto";
import { generateChecksum, addConnectEnvelope } from "./cursor-client";

// Cursor API URL (main API)
export const CURSOR_API_URL = "https://api2.cursor.sh";

// Agent backends
export const AGENT_PRIVACY_URL = "https://agent.api5.cursor.sh";
export const AGENT_NON_PRIVACY_URL = "https://agentn.api5.cursor.sh";

// Agent modes
export enum AgentMode {
  UNSPECIFIED = 0,
  AGENT = 1,
  ASK = 2,
  PLAN = 3,
  DEBUG = 4,
  TRIAGE = 5,
}

// --- Protobuf Encoding Helpers ---

function encodeVarint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  if (!value) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 2; // wire type 2 = length-delimited
  const encoded = new TextEncoder().encode(value);
  const length = encodeVarint(encoded.length);
  
  const result = new Uint8Array(1 + length.length + encoded.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(encoded, 1 + length.length);
  
  return result;
}

function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  const encoded = encodeVarint(value);
  
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  
  return result;
}

function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  const encoded = encodeVarint(value);
  
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  
  return result;
}

function encodeInt64Field(fieldNumber: number, value: bigint): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  const encoded = encodeVarint(value);
  
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  
  return result;
}

function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 2; // wire type 2 = length-delimited
  const length = encodeVarint(data.length);
  
  const result = new Uint8Array(1 + length.length + data.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(data, 1 + length.length);
  
  return result;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeBoolField(fieldNumber: number, value: boolean): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  return new Uint8Array([fieldTag, value ? 1 : 0]);
}

function encodeDoubleField(fieldNumber: number, value: number): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 1; // wire type 1 = 64-bit
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, fieldTag);
  view.setFloat64(1, value, true); // little-endian
  return new Uint8Array(buffer);
}

// --- google.protobuf.Value Encoding ---

/**
 * Encode a JavaScript value as google.protobuf.Value
 * 
 * google.protobuf.Value oneof:
 *   field 1: null_value (enum NullValue)
 *   field 2: number_value (double)
 *   field 3: string_value (string)
 *   field 4: bool_value (bool)
 *   field 5: struct_value (Struct)
 *   field 6: list_value (ListValue)
 */
function encodeProtobufValue(value: any): Uint8Array {
  if (value === null || value === undefined) {
    // NullValue enum = 0
    return encodeUint32Field(1, 0);
  }
  
  if (typeof value === "number") {
    return encodeDoubleField(2, value);
  }
  
  if (typeof value === "string") {
    return encodeStringField(3, value);
  }
  
  if (typeof value === "boolean") {
    return encodeBoolField(4, value);
  }
  
  if (Array.isArray(value)) {
    // ListValue: field 1 = repeated Value
    const listBytes: Uint8Array[] = [];
    for (const item of value) {
      const itemValue = encodeProtobufValue(item);
      listBytes.push(encodeMessageField(1, itemValue));
    }
    const listValue = concatBytes(...listBytes);
    return encodeMessageField(6, listValue);
  }
  
  if (typeof value === "object") {
    // Struct: field 1 = map<string, Value> (encoded as repeated MapEntry)
    // MapEntry: field 1 = key (string), field 2 = value (Value)
    const structBytes: Uint8Array[] = [];
    for (const [key, val] of Object.entries(value)) {
      const keyBytes = encodeStringField(1, key);
      const valBytes = encodeMessageField(2, encodeProtobufValue(val));
      const mapEntry = concatBytes(keyBytes, valBytes);
      structBytes.push(encodeMessageField(1, mapEntry));
    }
    const structValue = concatBytes(...structBytes);
    return encodeMessageField(5, structValue);
  }
  
  // Fallback: encode as string
  return encodeStringField(3, String(value));
}

// --- MCP Tool Definition Encoding ---

/**
 * Tool definition in OpenAI format
 */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

/**
 * Encode McpToolDefinition message
 * 
 * McpToolDefinition:
 *   field 1: name (string) - unique identifier for the tool
 *   field 2: description (string)
 *   field 3: input_schema (google.protobuf.Value)
 *   field 4: provider_identifier (string)
 *   field 5: tool_name (string)
 */
function encodeMcpToolDefinition(tool: OpenAIToolDefinition, providerIdentifier: string = "cursor-tools"): Uint8Array {
  const toolName = tool.function.name;
  // The name field should be the combined identifier (provider-toolname) with hyphen
  // This matches how Cursor's McpManager creates tool names: `${tool.clientName}-${tool.name}`
  // Using "cursor-tools" as provider to look like a built-in provider
  const combinedName = `${providerIdentifier}-${toolName}`;
  const description = tool.function.description ?? "";
  const inputSchema = tool.function.parameters ?? { type: "object", properties: {} };
  
  console.log(`[DEBUG] Encoding tool: name=${combinedName}, providerIdentifier=${providerIdentifier}, toolName=${toolName}`);
  
  const parts: Uint8Array[] = [
    encodeStringField(1, combinedName),
    encodeStringField(2, description),
  ];
  
  // Encode input_schema as google.protobuf.Value
  if (inputSchema) {
    const schemaValue = encodeProtobufValue(inputSchema);
    parts.push(encodeMessageField(3, schemaValue));
  }
  
  parts.push(encodeStringField(4, providerIdentifier));
  parts.push(encodeStringField(5, toolName));
  
  return concatBytes(...parts);
}

// --- Proto Message Builders ---

/**
 * Encode BidiRequestId
 * - request_id: field 1 (string)
 */
function encodeBidiRequestId(requestId: string): Uint8Array {
  return encodeStringField(1, requestId);
}

/**
 * Encode BidiAppendRequest
 * - data: field 1 (string, hex-encoded)
 * - request_id: field 2 (BidiRequestId message)
 * - append_seqno: field 3 (int64)
 */
function encodeBidiAppendRequest(data: string, requestId: string, appendSeqno: bigint): Uint8Array {
  const requestIdMsg = encodeBidiRequestId(requestId);
  return concatBytes(
    encodeStringField(1, data),
    encodeMessageField(2, requestIdMsg),
    encodeInt64Field(3, appendSeqno)
  );
}

/**
 * Build RequestContextEnv
 * field 1: os_version (string)
 * field 2: workspace_paths (repeated string) 
 * field 3: shell (string)
 * field 10: time_zone (string)
 * field 11: project_folder (string)
 */
function buildRequestContextEnv(workspacePath: string = process.cwd()): Uint8Array {
  return concatBytes(
    encodeStringField(1, `darwin 24.0.0`),
    encodeStringField(2, workspacePath),
    encodeStringField(3, '/bin/zsh'),
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),
    encodeStringField(11, workspacePath),
  );
}

/**
 * Encode McpInstructions message
 * McpInstructions:
 *   field 1: server_name (string)
 *   field 2: instructions (string)
 */
function encodeMcpInstructions(serverName: string, instructions: string): Uint8Array {
  return concatBytes(
    encodeStringField(1, serverName),
    encodeStringField(2, instructions)
  );
}

/**
 * Build RequestContext
 * field 2: rules (repeated CursorRule) - optional
 * field 4: env (RequestContextEnv)
 * field 7: tools (repeated McpToolDefinition) - IMPORTANT for tool calling
 * field 11: git_repos (repeated GitRepoInfo) - optional
 * field 14: mcp_instructions (repeated McpInstructions) - instructions for MCP tools
 */
function buildRequestContext(workspacePath?: string, tools?: OpenAIToolDefinition[]): Uint8Array {
  const parts: Uint8Array[] = [];
  
  // field 4: env
  const env = buildRequestContextEnv(workspacePath);
  parts.push(encodeMessageField(4, env));
  
  // field 7: tools (repeated McpToolDefinition)
  // Enable tools in RequestContext - this is where Cursor expects MCP tool definitions
  // Use "cursor-tools" as provider identifier to look like a built-in tool provider
  const MCP_PROVIDER = "cursor-tools";
  if (tools && tools.length > 0) {
    console.log(`[DEBUG] Adding ${tools.length} tools to RequestContext.tools (field 7)`);
    for (const tool of tools) {
      const mcpTool = encodeMcpToolDefinition(tool, MCP_PROVIDER);
      parts.push(encodeMessageField(7, mcpTool));
    }
    
    // field 14: mcp_instructions - provide instructions for the MCP tools
    // Build instruction text describing all tools
    const toolDescriptions = tools.map(t => 
      `- ${t.function.name}: ${t.function.description || 'No description'}`
    ).join('\n');
    const instructions = `You have access to the following tools:\n${toolDescriptions}\n\nUse these tools when appropriate to help the user.`;
    
    const mcpInstr = encodeMcpInstructions(MCP_PROVIDER, instructions);
    parts.push(encodeMessageField(14, mcpInstr));
    console.log(`[DEBUG] Added MCP instructions for ${MCP_PROVIDER} server`);
  }
  
  return concatBytes(...parts);
}

/**
 * Encode UserMessage
 * - text: field 1 (string)
 * - message_id: field 2 (string)
 * - mode: field 4 (enum/int32)
 */
function encodeUserMessage(text: string, messageId: string, mode: AgentMode = AgentMode.ASK): Uint8Array {
  console.log(`[DEBUG] encodeUserMessage: mode=${mode} (${AgentMode[mode]}), messageId=${messageId}`);
  return concatBytes(
    encodeStringField(1, text),
    encodeStringField(2, messageId),
    encodeInt32Field(4, mode)
  );
}

/**
 * Encode UserMessageAction
 * - user_message: field 1 (UserMessage)
 * - request_context: field 2 (RequestContext) - REQUIRED for agent to work
 */
function encodeUserMessageAction(userMessage: Uint8Array, requestContext: Uint8Array): Uint8Array {
  return concatBytes(
    encodeMessageField(1, userMessage),
    encodeMessageField(2, requestContext)
  );
}

/**
 * Encode ConversationAction
 * - user_message_action: field 1 (UserMessageAction)
 */
function encodeConversationAction(userMessageAction: Uint8Array): Uint8Array {
  return encodeMessageField(1, userMessageAction);
}

/**
 * Encode ModelDetails
 * - model_id: field 1 (string)
 */
function encodeModelDetails(modelId: string): Uint8Array {
  return encodeStringField(1, modelId);
}

/**
 * Encode ConversationStateStructure (empty for new conversation)
 * This is required even for new conversations
 */
function encodeEmptyConversationState(): Uint8Array {
  return new Uint8Array(0);
}

/**
 * Encode McpTools wrapper message
 * McpTools:
 *   field 1: mcp_tools (repeated McpToolDefinition)
 * 
 * This is a wrapper message that contains repeated tool definitions
 */
function encodeMcpTools(tools: OpenAIToolDefinition[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const MCP_PROVIDER = "cursor-tools";
  for (const tool of tools) {
    const mcpTool = encodeMcpToolDefinition(tool, MCP_PROVIDER);
    // field 1 in McpTools = repeated McpToolDefinition
    parts.push(encodeMessageField(1, mcpTool));
  }
  return concatBytes(...parts);
}

/**
 * Encode McpDescriptor message
 * McpDescriptor:
 *   field 1: server_name (string) - Display name of the MCP server
 *   field 2: server_identifier (string) - Unique identifier
 *   field 3: folder_path (string, optional)
 *   field 4: server_use_instructions (string, optional)
 */
function encodeMcpDescriptor(
  serverName: string,
  serverIdentifier: string,
  folderPath?: string,
  serverUseInstructions?: string
): Uint8Array {
  const parts: Uint8Array[] = [
    encodeStringField(1, serverName),
    encodeStringField(2, serverIdentifier),
  ];
  
  if (folderPath) {
    parts.push(encodeStringField(3, folderPath));
  }
  
  if (serverUseInstructions) {
    parts.push(encodeStringField(4, serverUseInstructions));
  }
  
  return concatBytes(...parts);
}

/**
 * Encode McpFileSystemOptions message
 * McpFileSystemOptions:
 *   field 1: enabled (bool)
 *   field 2: workspace_project_dir (string)
 *   field 3: mcp_descriptors (repeated McpDescriptor)
 */
function encodeMcpFileSystemOptions(
  enabled: boolean,
  workspaceProjectDir: string,
  mcpDescriptors: Array<{ serverName: string; serverIdentifier: string; folderPath?: string; serverUseInstructions?: string }>
): Uint8Array {
  const parts: Uint8Array[] = [];
  
  // field 1: enabled
  if (enabled) {
    parts.push(encodeBoolField(1, true));
  }
  
  // field 2: workspace_project_dir
  if (workspaceProjectDir) {
    parts.push(encodeStringField(2, workspaceProjectDir));
  }
  
  // field 3: mcp_descriptors (repeated)
  for (const descriptor of mcpDescriptors) {
    const encodedDescriptor = encodeMcpDescriptor(
      descriptor.serverName,
      descriptor.serverIdentifier,
      descriptor.folderPath,
      descriptor.serverUseInstructions
    );
    parts.push(encodeMessageField(3, encodedDescriptor));
  }
  
  return concatBytes(...parts);
}

/**
 * Debug helper: dump protobuf as hex string
 */
function hexDump(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

/**
 * Encode AgentRunRequest
 * - conversation_state: field 1 (ConversationStateStructure) - required, empty for new conversation
 * - action: field 2 (ConversationAction)
 * - model_details: field 3 (ModelDetails)
 * - mcp_tools: field 4 (McpTools) - tool definitions
 * - conversation_id: field 5 (string, optional)
 * - mcp_file_system_options: field 6 (McpFileSystemOptions, optional) - enables MCP tool execution
 */
function encodeAgentRunRequest(
  action: Uint8Array,
  modelDetails: Uint8Array,
  conversationId?: string,
  tools?: OpenAIToolDefinition[],
  workspacePath?: string
): Uint8Array {
  const conversationState = encodeEmptyConversationState();
  
  const parts: Uint8Array[] = [
    encodeMessageField(1, conversationState),
    encodeMessageField(2, action),
    encodeMessageField(3, modelDetails),
  ];
  
  // field 4: mcp_tools (McpTools wrapper)
  // This mirrors how Cursor builds AgentRunRequest - tools go in BOTH:
  // 1. RequestContext.tools (field 7) - already added in buildRequestContext
  // 2. AgentRunRequest.mcp_tools (field 4) - added here
  if (tools && tools.length > 0) {
    const mcpToolsWrapper = encodeMcpTools(tools);
    parts.push(encodeMessageField(4, mcpToolsWrapper));
    console.log(`[DEBUG] Added mcp_tools (field 4) to AgentRunRequest with ${tools.length} tools`);
  }
  
  // Add conversation_id if provided (field 5)
  if (conversationId) {
    parts.push(encodeStringField(5, conversationId));
  }
  
  // field 6: mcp_file_system_options
  // This enables MCP tool execution - provides workspace context and descriptor info
  if (tools && tools.length > 0 && workspacePath) {
    const MCP_PROVIDER = "cursor-tools";
    const mcpDescriptors = [{
      serverName: "Cursor Tools",
      serverIdentifier: MCP_PROVIDER,
      folderPath: workspacePath,
      serverUseInstructions: "Use these tools to assist the user with their coding tasks."
    }];
    const mcpFsOptions = encodeMcpFileSystemOptions(true, workspacePath, mcpDescriptors);
    parts.push(encodeMessageField(6, mcpFsOptions));
    console.log(`[DEBUG] Added mcp_file_system_options (field 6) with workspace: ${workspacePath}`);
  }
  
  return concatBytes(...parts);
}

/**
 * Encode AgentClientMessage with run_request
 * - run_request: field 1 (AgentRunRequest)
 */
function encodeAgentClientMessage(runRequest: Uint8Array): Uint8Array {
  return encodeMessageField(1, runRequest);
}

/**
 * Build KvClientMessage
 * KvClientMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_result (GetBlobResult)
 *   field 3: set_blob_result (SetBlobResult)
 */
function buildKvClientMessage(id: number, resultType: 'get_blob_result' | 'set_blob_result', result: Uint8Array): Uint8Array {
  const fieldNumber = resultType === 'get_blob_result' ? 2 : 3;
  return concatBytes(
    encodeUint32Field(1, id),
    encodeMessageField(fieldNumber, result)
  );
}

/**
 * Build AgentClientMessage with kv_client_message
 * AgentClientMessage:
 *   field 3: kv_client_message (KvClientMessage)
 */
function buildAgentClientMessageWithKv(kvClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(3, kvClientMessage);
}

// --- Response Parsing ---

interface ParsedField {
  fieldNumber: number;
  wireType: number;
  value: Uint8Array | number | bigint;
}

function decodeVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  
  return { value, bytesRead };
}

function parseProtoFields(data: Uint8Array): ParsedField[] {
  const fields: ParsedField[] = [];
  let offset = 0;
  
  while (offset < data.length) {
    const tagInfo = decodeVarint(data, offset);
    offset += tagInfo.bytesRead;
    
    const fieldNumber = tagInfo.value >> 3;
    const wireType = tagInfo.value & 0x7;
    
    if (wireType === 2) { // length-delimited
      const lengthInfo = decodeVarint(data, offset);
      offset += lengthInfo.bytesRead;
      const value = data.slice(offset, offset + lengthInfo.value);
      offset += lengthInfo.value;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 0) { // varint
      const valueInfo = decodeVarint(data, offset);
      offset += valueInfo.bytesRead;
      fields.push({ fieldNumber, wireType, value: valueInfo.value });
    } else if (wireType === 1) { // 64-bit
      const value = data.slice(offset, offset + 8);
      offset += 8;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 5) { // 32-bit
      const value = data.slice(offset, offset + 4);
      offset += 4;
      fields.push({ fieldNumber, wireType, value });
    } else {
      break;
    }
  }
  
  return fields;
}

// --- KV Message Parsing ---

interface KvServerMessage {
  id: number;
  messageType: 'get_blob_args' | 'set_blob_args' | 'unknown';
  blobId?: Uint8Array;
  blobData?: Uint8Array;
}

function parseKvServerMessage(data: Uint8Array): KvServerMessage {
  const fields = parseProtoFields(data);
  const result: KvServerMessage = { id: 0, messageType: 'unknown' };
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = field.value as number;
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.messageType = 'get_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        }
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.messageType = 'set_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        } else if (af.fieldNumber === 2 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobData = af.value;
        }
      }
    }
  }
  
  return result;
}

// --- Exec Message Types ---

/**
 * Parsed ExecServerMessage with mcp_args
 */
export interface McpExecRequest {
  id: number;           // Execution ID - must be returned in response
  execId?: string;      // Optional exec ID
  name: string;         // Combined name like "opencode___bash"
  args: Record<string, any>;  // Tool arguments
  toolCallId: string;   // Tool call ID
  providerIdentifier: string; // e.g., "opencode"
  toolName: string;     // e.g., "bash"
}

/**
 * Shell execution request (shell_args or shell_stream_args)
 */
export interface ShellExecRequest {
  type: 'shell';
  id: number;
  execId?: string;
  command: string;
  cwd?: string;
}

/**
 * LS (directory listing) request
 */
export interface LsExecRequest {
  type: 'ls';
  id: number;
  execId?: string;
  path: string;
}

/**
 * Request context request
 */
export interface RequestContextExecRequest {
  type: 'request_context';
  id: number;
  execId?: string;
}

/**
 * Read file request
 */
export interface ReadExecRequest {
  type: 'read';
  id: number;
  execId?: string;
  path: string;
}

/**
 * Union type for all exec requests
 */
export type ExecRequest = 
  | (McpExecRequest & { type: 'mcp' })
  | ShellExecRequest 
  | LsExecRequest 
  | RequestContextExecRequest
  | ReadExecRequest;

/**
 * Parse google.protobuf.Value from protobuf bytes
 */
function parseProtobufValue(data: Uint8Array): any {
  const fields = parseProtoFields(data);
  
  for (const field of fields) {
    // null_value = field 1 (varint, NullValue enum)
    if (field.fieldNumber === 1 && field.wireType === 0) {
      return null;
    }
    // number_value = field 2 (double, wire type 1)
    if (field.fieldNumber === 2 && field.wireType === 1 && field.value instanceof Uint8Array) {
      const view = new DataView(field.value.buffer, field.value.byteOffset, 8);
      return view.getFloat64(0, true);
    }
    // string_value = field 3 (string)
    if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      return new TextDecoder().decode(field.value);
    }
    // bool_value = field 4 (bool)
    if (field.fieldNumber === 4 && field.wireType === 0) {
      return field.value === 1;
    }
    // struct_value = field 5 (Struct message)
    if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
      return parseProtobufStruct(field.value);
    }
    // list_value = field 6 (ListValue message)
    if (field.fieldNumber === 6 && field.wireType === 2 && field.value instanceof Uint8Array) {
      return parseProtobufListValue(field.value);
    }
  }
  
  return undefined;
}

/**
 * Parse google.protobuf.Struct (map<string, Value>)
 */
function parseProtobufStruct(data: Uint8Array): Record<string, any> {
  const fields = parseProtoFields(data);
  const result: Record<string, any> = {};
  
  for (const field of fields) {
    // field 1 = repeated MapEntry (fields: field 1 = key, field 2 = value)
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const entryFields = parseProtoFields(field.value);
      let key = "";
      let value: any = undefined;
      
      for (const ef of entryFields) {
        if (ef.fieldNumber === 1 && ef.wireType === 2 && ef.value instanceof Uint8Array) {
          key = new TextDecoder().decode(ef.value);
        }
        if (ef.fieldNumber === 2 && ef.wireType === 2 && ef.value instanceof Uint8Array) {
          value = parseProtobufValue(ef.value);
        }
      }
      
      if (key) {
        result[key] = value;
      }
    }
  }
  
  return result;
}

/**
 * Parse google.protobuf.ListValue (repeated Value)
 */
function parseProtobufListValue(data: Uint8Array): any[] {
  const fields = parseProtoFields(data);
  const result: any[] = [];
  
  for (const field of fields) {
    // field 1 = repeated Value
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.push(parseProtobufValue(field.value));
    }
  }
  
  return result;
}

/**
 * Parse McpArgs from protobuf bytes
 * McpArgs:
 *   field 1: name (string)
 *   field 2: args (map<string, google.protobuf.Value>)
 *   field 3: tool_call_id (string)
 *   field 4: provider_identifier (string)
 *   field 5: tool_name (string)
 */
function parseMcpArgs(data: Uint8Array): Omit<McpExecRequest, 'id' | 'execId'> {
  const fields = parseProtoFields(data);
  let name = "";
  const args: Record<string, any> = {};
  let toolCallId = "";
  let providerIdentifier = "";
  let toolName = "";
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      name = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      // Map entry: field 1 = key (string), field 2 = value (google.protobuf.Value)
      const entryFields = parseProtoFields(field.value);
      let key = "";
      let value: any = undefined;
      
      for (const ef of entryFields) {
        if (ef.fieldNumber === 1 && ef.wireType === 2 && ef.value instanceof Uint8Array) {
          key = new TextDecoder().decode(ef.value);
        }
        if (ef.fieldNumber === 2 && ef.wireType === 2 && ef.value instanceof Uint8Array) {
          value = parseProtobufValue(ef.value);
        }
      }
      
      if (key) {
        args[key] = value;
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolCallId = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
      providerIdentifier = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolName = new TextDecoder().decode(field.value);
    }
  }
  
  return { name, args, toolCallId, providerIdentifier, toolName };
}

/**
 * ExecServerMessage field mapping
 */
const EXEC_MESSAGE_TYPES: Record<number, string> = {
  2: "shell_args",
  3: "write_args",
  4: "delete_args", 
  5: "grep_args",
  7: "read_args",
  8: "ls_args",
  9: "diagnostics_args",
  10: "request_context_args",
  11: "mcp_args",
  14: "shell_stream_args",
  16: "background_shell_spawn_args",
  17: "list_mcp_resources_exec_args",
  18: "read_mcp_resource_exec_args",
  20: "fetch_args",
  21: "record_screen_args",
  22: "computer_use_args",
};

/**
 * Parse shell_args or shell_stream_args
 * ShellArgs:
 *   field 1: command (string)
 *   field 2: working_directory (string)
 */
function parseShellArgs(data: Uint8Array): { command: string; cwd?: string } {
  const fields = parseProtoFields(data);
  let command = '';
  let cwd: string | undefined;
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      command = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      cwd = new TextDecoder().decode(field.value);
    }
  }
  
  return { command, cwd };
}

/**
 * Parse ls_args
 * LsArgs:
 *   field 1: path (string)
 */
function parseLsArgs(data: Uint8Array): { path: string } {
  const fields = parseProtoFields(data);
  let path = process.cwd();
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      path = new TextDecoder().decode(field.value);
    }
  }
  
  return { path };
}

/**
 * Parse read_args
 * ReadArgs:
 *   field 1: path (string)
 */
function parseReadArgs(data: Uint8Array): { path: string } {
  const fields = parseProtoFields(data);
  let path = '';
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      path = new TextDecoder().decode(field.value);
    }
  }
  
  return { path };
}

/**
 * Parse ExecServerMessage to extract all exec types
 * ExecServerMessage:
 *   field 1: id (uint32)
 *   field 15: exec_id (string)
 *   field 2: shell_args (ShellArgs)
 *   field 8: ls_args (LsArgs)
 *   field 10: request_context_args (RequestContextArgs)
 *   field 11: mcp_args (McpArgs)
 *   field 14: shell_stream_args (ShellArgs)
 */
function parseExecServerMessage(data: Uint8Array): ExecRequest | null {
  const fields = parseProtoFields(data);
  let id = 0;
  let execId: string | undefined = undefined;
  let result: ExecRequest | null = null;
  
  // First pass: get id and execId
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      id = field.value as number;
    } else if (field.fieldNumber === 15 && field.wireType === 2 && field.value instanceof Uint8Array) {
      execId = new TextDecoder().decode(field.value);
    }
  }
  
  // Second pass: get the exec type
  for (const field of fields) {
    if (field.wireType !== 2 || !(field.value instanceof Uint8Array)) continue;
    
    switch (field.fieldNumber) {
      case 2: // shell_args
      case 14: { // shell_stream_args
        const shellArgs = parseShellArgs(field.value);
        result = { type: 'shell', id, execId, command: shellArgs.command, cwd: shellArgs.cwd };
        break;
      }
      case 7: { // read_args
        const readArgs = parseReadArgs(field.value);
        result = { type: 'read', id, execId, path: readArgs.path };
        break;
      }
      case 8: { // ls_args
        const lsArgs = parseLsArgs(field.value);
        result = { type: 'ls', id, execId, path: lsArgs.path };
        break;
      }
      case 10: { // request_context_args
        result = { type: 'request_context', id, execId };
        break;
      }
      case 11: { // mcp_args
        const mcpArgs = parseMcpArgs(field.value);
        result = { type: 'mcp', id, execId, ...mcpArgs };
        break;
      }
    }
    
    if (result) {
      console.log(`[DEBUG] Parsed ExecServerMessage: type=${result.type}, id=${id}`);
      break;
    }
  }
  
  return result;
}

// --- Exec Response Builders ---

/**
 * Build McpTextContent message
 * field 1: text (string)
 */
function encodeMcpTextContent(text: string): Uint8Array {
  return encodeStringField(1, text);
}

/**
 * Build McpToolResultContentItem with text content
 * field 1: text (McpTextContent) - oneof content
 */
function encodeMcpToolResultContentItem(text: string): Uint8Array {
  const textContent = encodeMcpTextContent(text);
  return encodeMessageField(1, textContent);
}

/**
 * Build McpSuccess message
 * field 1: content (repeated McpToolResultContentItem)
 * field 2: is_error (bool)
 */
function encodeMcpSuccess(content: string, isError: boolean = false): Uint8Array {
  const parts: Uint8Array[] = [];
  
  // Add content item
  const contentItem = encodeMcpToolResultContentItem(content);
  parts.push(encodeMessageField(1, contentItem));
  
  // Add is_error if true
  if (isError) {
    parts.push(encodeBoolField(2, true));
  }
  
  return concatBytes(...parts);
}

/**
 * Build McpError message
 * field 1: error (string)
 */
function encodeMcpError(error: string): Uint8Array {
  return encodeStringField(1, error);
}

/**
 * Build McpResult message
 * field 1: success (McpSuccess) - oneof result
 * field 2: error (McpError) - oneof result
 */
function encodeMcpResult(result: { success?: { content: string; isError?: boolean }; error?: string }): Uint8Array {
  if (result.success) {
    const success = encodeMcpSuccess(result.success.content, result.success.isError);
    return encodeMessageField(1, success);
  } else if (result.error) {
    const error = encodeMcpError(result.error);
    return encodeMessageField(2, error);
  }
  
  // Default to empty success
  return encodeMessageField(1, encodeMcpSuccess(""));
}

/**
 * Build ExecClientMessage with mcp_result
 * ExecClientMessage:
 *   field 1: id (uint32)
 *   field 15: exec_id (string) - optional
 *   field 11: mcp_result (McpResult) - oneof message
 */
function buildExecClientMessage(
  id: number,
  execId: string | undefined,
  result: { success?: { content: string; isError?: boolean }; error?: string }
): Uint8Array {
  const parts: Uint8Array[] = [];
  
  // field 1: id
  parts.push(encodeUint32Field(1, id));
  
  // field 15: exec_id (optional)
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  
  // field 11: mcp_result
  const mcpResult = encodeMcpResult(result);
  parts.push(encodeMessageField(11, mcpResult));
  
  return concatBytes(...parts);
}

/**
 * Build ExecClientStreamClose message
 * field 1: id (uint32)
 */
function encodeExecClientStreamClose(id: number): Uint8Array {
  return encodeUint32Field(1, id);
}

/**
 * Build ExecClientControlMessage with stream_close
 * ExecClientControlMessage:
 *   field 1: stream_close (ExecClientStreamClose) - oneof message
 */
function buildExecClientControlMessage(id: number): Uint8Array {
  const streamClose = encodeExecClientStreamClose(id);
  return encodeMessageField(1, streamClose);
}

/**
 * Build AgentClientMessage with exec_client_message
 * AgentClientMessage:
 *   field 2: exec_client_message (ExecClientMessage)
 */
function buildAgentClientMessageWithExec(execClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(2, execClientMessage);
}

/**
 * Build ShellResult message with proper nested structure
 * ShellResult:
 *   field 1: success (ShellSuccess) - oneof result
 *   field 2: failure (ShellFailure) - oneof result
 * ShellSuccess/ShellFailure:
 *   field 1: command (string)
 *   field 2: working_directory (string)
 *   field 3: exit_code (int32)
 *   field 4: signal (string)
 *   field 5: stdout (string)
 *   field 6: stderr (string)
 *   field 7: execution_time (int32) - optional
 */
function encodeShellResult(command: string, cwd: string, stdout: string, stderr: string, exitCode: number, executionTimeMs?: number): Uint8Array {
  // Build ShellSuccess or ShellFailure (same structure, different field number in result)
  const shellOutcome = concatBytes(
    encodeStringField(1, command),
    encodeStringField(2, cwd),
    encodeInt32Field(3, exitCode),
    encodeStringField(4, ""),  // signal (empty)
    encodeStringField(5, stdout),
    encodeStringField(6, stderr),
    executionTimeMs ? encodeInt32Field(7, executionTimeMs) : new Uint8Array(0),
  );
  
  // Wrap in ShellResult - field 1 for success, field 2 for failure
  const resultField = exitCode === 0 ? 1 : 2;
  return encodeMessageField(resultField, shellOutcome);
}

/**
 * Build ExecClientMessage with shell_result
 * ExecClientMessage:
 *   field 1: id (uint32)
 *   field 15: exec_id (string) - optional
 *   field 2: shell_result (ShellResult) - oneof message
 */
function buildExecClientMessageWithShellResult(
  id: number, 
  execId: string | undefined, 
  command: string,
  cwd: string,
  stdout: string, 
  stderr: string,
  exitCode: number,
  executionTimeMs?: number
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(2, encodeShellResult(command, cwd, stdout, stderr, exitCode, executionTimeMs)));
  return concatBytes(...parts);
}

/**
 * Build LsResult message
 * LsResult:
 *   field 1: success (LsSuccess) - oneof result
 * LsSuccess:
 *   field 1: files_string (string)
 */
function encodeLsResult(filesString: string): Uint8Array {
  const lsSuccess = encodeStringField(1, filesString);
  return encodeMessageField(1, lsSuccess);
}

/**
 * Build ExecClientMessage with ls_result
 * ExecClientMessage:
 *   field 1: id (uint32)
 *   field 15: exec_id (string) - optional
 *   field 8: ls_result (LsResult) - oneof message
 */
function buildExecClientMessageWithLsResult(id: number, execId: string | undefined, filesString: string): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(8, encodeLsResult(filesString)));
  return concatBytes(...parts);
}

/**
 * Build RequestContextResult message
 * RequestContextResult:
 *   field 1: success (RequestContextSuccess) - oneof result
 * RequestContextSuccess:
 *   field 1: request_context (RequestContext)
 * RequestContext:
 *   field 4: env (RequestContextEnv)
 */
function encodeRequestContextResult(): Uint8Array {
  const cwd = process.cwd();
  const osVersion = `darwin ${require('os').release()}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shell = process.env.SHELL || '/bin/zsh';
  
  // RequestContextEnv
  const env = concatBytes(
    encodeStringField(1, osVersion),
    encodeStringField(2, cwd),
    encodeStringField(3, shell),
    encodeStringField(10, timeZone),
    encodeStringField(11, cwd),
  );
  
  // RequestContext
  const requestContext = encodeMessageField(4, env);
  
  // RequestContextSuccess
  const success = encodeMessageField(1, requestContext);
  
  // RequestContextResult
  return encodeMessageField(1, success);
}

/**
 * Build ExecClientMessage with request_context_result
 * ExecClientMessage:
 *   field 1: id (uint32)
 *   field 15: exec_id (string) - optional
 *   field 10: request_context_result (RequestContextResult) - oneof message
 */
function buildExecClientMessageWithRequestContextResult(id: number, execId: string | undefined): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(10, encodeRequestContextResult()));
  return concatBytes(...parts);
}

/**
 * Build ReadResult message
 * ReadResult:
 *   field 1: success (ReadSuccess) - oneof result
 * ReadSuccess:
 *   field 1: content (string)
 */
function encodeReadResult(content: string): Uint8Array {
  const readSuccess = encodeStringField(1, content);
  return encodeMessageField(1, readSuccess);
}

/**
 * Build ExecClientMessage with read_result
 * ExecClientMessage:
 *   field 1: id (uint32)
 *   field 15: exec_id (string) - optional
 *   field 7: read_result (ReadResult) - oneof message
 */
function buildExecClientMessageWithReadResult(id: number, execId: string | undefined, content: string): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(7, encodeReadResult(content)));
  return concatBytes(...parts);
}

/**
 * Build AgentClientMessage with exec_client_control_message
 * AgentClientMessage:
 *   field 5: exec_client_control_message (ExecClientControlMessage)
 */
function buildAgentClientMessageWithExecControl(execClientControlMessage: Uint8Array): Uint8Array {
  return encodeMessageField(5, execClientControlMessage);
}

// --- Tool Call Parsing ---

/**
 * Tool type field number to name mapping
 * Based on agent.v1.ToolCall oneof field numbers
 */
const TOOL_FIELD_MAP: Record<number, { type: string; name: string }> = {
  1: { type: "shell_tool_call", name: "bash" },
  3: { type: "delete_tool_call", name: "delete" },
  4: { type: "glob_tool_call", name: "glob" },
  5: { type: "grep_tool_call", name: "grep" },
  8: { type: "read_tool_call", name: "read" },
  9: { type: "update_todos_tool_call", name: "todowrite" },
  10: { type: "read_todos_tool_call", name: "todoread" },
  12: { type: "edit_tool_call", name: "edit" },
  13: { type: "ls_tool_call", name: "list" },
  14: { type: "read_lints_tool_call", name: "read_lints" },
  15: { type: "mcp_tool_call", name: "mcp" },
  16: { type: "sem_search_tool_call", name: "semantic_search" },
  17: { type: "create_plan_tool_call", name: "create_plan" },
  18: { type: "web_search_tool_call", name: "web_search" },
  19: { type: "task_tool_call", name: "task" },
  20: { type: "list_mcp_resources_tool_call", name: "list_mcp_resources" },
  21: { type: "read_mcp_resource_tool_call", name: "read_mcp_resource" },
  22: { type: "apply_agent_diff_tool_call", name: "apply_diff" },
  23: { type: "ask_question_tool_call", name: "ask_question" },
  24: { type: "fetch_tool_call", name: "webfetch" },
  25: { type: "switch_mode_tool_call", name: "switch_mode" },
  26: { type: "exa_search_tool_call", name: "exa_search" },
  27: { type: "exa_fetch_tool_call", name: "exa_fetch" },
  28: { type: "generate_image_tool_call", name: "generate_image" },
  29: { type: "record_screen_tool_call", name: "record_screen" },
  30: { type: "computer_use_tool_call", name: "computer_use" },
};

/**
 * Parse a ToolCall message to extract tool type and arguments
 */
function parseToolCall(data: Uint8Array): { toolType: string; name: string; arguments: Record<string, any> } {
  const fields = parseProtoFields(data);
  let toolType = "unknown";
  let name = "unknown";
  const args: Record<string, any> = {};
  
  for (const field of fields) {
    const toolInfo = TOOL_FIELD_MAP[field.fieldNumber];
    if (toolInfo && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolType = toolInfo.type;
      name = toolInfo.name;
      
      // Parse the nested tool-specific message to extract arguments
      const toolFields = parseProtoFields(field.value);
      for (const tf of toolFields) {
        if (tf.wireType === 2 && tf.value instanceof Uint8Array) {
          // Try to decode as string
          try {
            const strValue = new TextDecoder().decode(tf.value);
            args[`field_${tf.fieldNumber}`] = strValue;
          } catch {
            args[`field_${tf.fieldNumber}`] = `<binary:${tf.value.length}bytes>`;
          }
        } else if (tf.wireType === 0) {
          args[`field_${tf.fieldNumber}`] = tf.value;
        }
      }
      break; // Found the tool, stop
    }
  }
  
  return { toolType, name, arguments: args };
}

/**
 * Parse ToolCallStartedUpdate message
 * field 1: call_id (string)
 * field 2: tool_call (ToolCall message)
 * field 3: model_call_id (string)
 */
function parseToolCallStartedUpdate(data: Uint8Array): { callId: string; modelCallId: string; toolCall: { toolType: string; name: string; arguments: Record<string, any> } | null } {
  const fields = parseProtoFields(data);
  let callId = "";
  let modelCallId = "";
  let toolCall: { toolType: string; name: string; arguments: Record<string, any> } | null = null;
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      callId = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolCall = parseToolCall(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      modelCallId = new TextDecoder().decode(field.value);
    }
  }
  
  return { callId, modelCallId, toolCall };
}

/**
 * Parse PartialToolCallUpdate message
 * field 1: call_id (string)
 * field 2: tool_call (ToolCall message) - optional
 * field 3: args_text_delta (string) - partial JSON args
 * field 4: model_call_id (string)
 */
function parsePartialToolCallUpdate(data: Uint8Array): { callId: string; modelCallId: string; argsTextDelta: string; toolCall: { toolType: string; name: string; arguments: Record<string, any> } | null } {
  const fields = parseProtoFields(data);
  let callId = "";
  let modelCallId = "";
  let argsTextDelta = "";
  let toolCall: { toolType: string; name: string; arguments: Record<string, any> } | null = null;
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      callId = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolCall = parseToolCall(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      argsTextDelta = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
      modelCallId = new TextDecoder().decode(field.value);
    }
  }
  
  return { callId, modelCallId, argsTextDelta, toolCall };
}

// --- Stream Chunk Types ---

/**
 * Tool call information extracted from Cursor's ToolCall message
 */
export interface ToolCallInfo {
  callId: string;
  modelCallId?: string;
  toolType: string;       // e.g., "shell_tool_call", "read_tool_call", etc.
  name: string;           // human-readable name
  arguments: string;      // JSON string of arguments
}

export interface AgentStreamChunk {
  type: "text" | "thinking" | "token" | "checkpoint" | "done" | "error" | "tool_call_started" | "tool_call_completed" | "partial_tool_call" | "exec_request";
  content?: string;
  error?: string;
  toolCall?: ToolCallInfo;
  partialArgs?: string;   // For partial_tool_call updates
  execRequest?: ExecRequest;  // For exec_request chunks - tool execution needed
}

// --- Agent Service Client ---

export interface AgentServiceOptions {
  baseUrl?: string;
  privacyMode?: boolean;
  workspacePath?: string;
}

export interface AgentChatRequest {
  message: string;
  model?: string;
  mode?: AgentMode;
  conversationId?: string;
  tools?: OpenAIToolDefinition[];
}

export class AgentServiceClient {
  private baseUrl: string;
  private accessToken: string;
  private workspacePath: string;
  private blobStore: Map<string, Uint8Array>;
  
  // For tool result submission during streaming
  private currentRequestId: string | null = null;
  private currentAppendSeqno: bigint = 0n;

  constructor(accessToken: string, options: AgentServiceOptions = {}) {
    this.accessToken = accessToken;
    // Use main API endpoint (api2.cursor.sh) - agent.api5.cursor.sh requires feature flag
    this.baseUrl = options.baseUrl ?? CURSOR_API_URL;
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.blobStore = new Map();
    console.log(`[DEBUG] AgentServiceClient using baseUrl: ${this.baseUrl}`);
  }

  private getHeaders(requestId?: string): Record<string, string> {
    const checksum = generateChecksum(this.accessToken);
    
    const headers: Record<string, string> = {
      "authorization": `Bearer ${this.accessToken}`,
      "content-type": "application/grpc-web+proto",
      "user-agent": "connect-es/1.4.0",
      "x-cursor-checksum": checksum,
      "x-cursor-client-version": "cli-2025.11.25-d5b3271",
      "x-cursor-client-type": "cli",
      "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      "x-ghost-mode": "false",
    };
    
    if (requestId) {
      headers["x-request-id"] = requestId;
    }
    
    return headers;
  }

  private blobIdToKey(blobId: Uint8Array): string {
    return Buffer.from(blobId).toString('hex');
  }

  /**
   * Build the AgentClientMessage for a chat request
   */
  private buildChatMessage(request: AgentChatRequest): Uint8Array {
    const messageId = randomUUID();
    const conversationId = request.conversationId ?? randomUUID();
    const model = request.model ?? "gpt-4o";
    const mode = request.mode ?? AgentMode.AGENT;

    // Build RequestContext (REQUIRED for agent to work)
    // Include tools in RequestContext.tools (field 7) - CRITICAL for tool calling!
    const requestContext = buildRequestContext(this.workspacePath, request.tools);
    
    // Build the message hierarchy
    const userMessage = encodeUserMessage(request.message, messageId, mode);
    const userMessageAction = encodeUserMessageAction(userMessage, requestContext);
    const conversationAction = encodeConversationAction(userMessageAction);
    const modelDetails = encodeModelDetails(model);
    // Pass tools to AgentRunRequest (field 4: mcp_tools) and workspace path (for field 6: mcp_file_system_options)
    const agentRunRequest = encodeAgentRunRequest(conversationAction, modelDetails, conversationId, request.tools, this.workspacePath);
    const agentClientMessage = encodeAgentClientMessage(agentRunRequest);

    return agentClientMessage;
  }

  /**
   * Call BidiAppend to send a client message
   */
  private async bidiAppend(requestId: string, appendSeqno: bigint, data: Uint8Array): Promise<void> {
    const hexData = Buffer.from(data).toString("hex");
    const appendRequest = encodeBidiAppendRequest(hexData, requestId, appendSeqno);
    const envelope = addConnectEnvelope(appendRequest);
    
    const url = `${this.baseUrl}/aiserver.v1.BidiService/BidiAppend`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(requestId),
      body: Buffer.from(envelope),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Handle KV server message and send response
   */
  private async handleKvMessage(
    kvMsg: KvServerMessage, 
    requestId: string, 
    appendSeqno: bigint
  ): Promise<bigint> {
    if (kvMsg.messageType === 'get_blob_args' && kvMsg.blobId) {
      const key = this.blobIdToKey(kvMsg.blobId);
      const data = this.blobStore.get(key);
      
      // GetBlobResult: field 1 = blob_data (bytes, optional)
      const result = data ? encodeMessageField(1, data) : new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'get_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      
      await this.bidiAppend(requestId, appendSeqno, responseMsg);
      return appendSeqno + 1n;
    } else if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
      const key = this.blobIdToKey(kvMsg.blobId);
      this.blobStore.set(key, kvMsg.blobData);
      
      // Debug: try to decode blob data as text to see what it contains
      try {
        const text = new TextDecoder().decode(kvMsg.blobData);
        if (text.length < 500) {
          console.log(`[DEBUG] Blob data (text): ${text.slice(0, 200)}`);
        } else {
          console.log(`[DEBUG] Blob data (${kvMsg.blobData.length} bytes, first 200 chars): ${text.slice(0, 200)}`);
        }
      } catch {
        console.log(`[DEBUG] Blob data (${kvMsg.blobData.length} bytes, non-text)`);
      }
      
      // SetBlobResult: empty = no error
      const result = new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'set_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      
      await this.bidiAppend(requestId, appendSeqno, responseMsg);
      return appendSeqno + 1n;
    }
    return appendSeqno;
  }

  /**
   * Send a tool result back to the server (for MCP tools only)
   * This must be called during an active chat stream when an exec_request chunk is received
   */
  async sendToolResult(
    execRequest: McpExecRequest & { type: 'mcp' },
    result: { success?: { content: string; isError?: boolean }; error?: string }
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send tool result");
    }
    
    console.log("[DEBUG] Sending tool result for exec id:", execRequest.id, "result:", result.success ? "success" : "error");
    
    // Build ExecClientMessage with mcp_result
    const execClientMsg = buildExecClientMessage(
      execRequest.id,
      execRequest.execId,
      result
    );
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);
    
    // Send the result
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;
    
    console.log("[DEBUG] Tool result sent, new seqno:", this.currentAppendSeqno);
    
    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(execRequest.id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);
    
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;
    
    console.log("[DEBUG] Stream close sent for exec id:", execRequest.id);
  }

  /**
   * Send a shell execution result back to the server
   */
  async sendShellResult(
    id: number, 
    execId: string | undefined, 
    command: string,
    cwd: string,
    stdout: string, 
    stderr: string,
    exitCode: number,
    executionTimeMs?: number
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send shell result");
    }
    
    console.log("[DEBUG] Sending shell result for id:", id, "exitCode:", exitCode);
    
    const execClientMsg = buildExecClientMessageWithShellResult(id, execId, command, cwd, stdout, stderr, exitCode, executionTimeMs);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);
    
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;
  }

  /**
   * Send an LS result back to the server
   */
  async sendLsResult(id: number, execId: string | undefined, filesString: string): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send ls result");
    }
    
    console.log("[DEBUG] Sending ls result for id:", id);
    
    const execClientMsg = buildExecClientMessageWithLsResult(id, execId, filesString);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);
    
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;
  }

  /**
   * Send a request context result back to the server
   */
  async sendRequestContextResult(id: number, execId: string | undefined): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send request context result");
    }
    
    console.log("[DEBUG] Sending request context result for id:", id);
    
    const execClientMsg = buildExecClientMessageWithRequestContextResult(id, execId);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);
    
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;
  }

  /**
   * Send a file read result back to the server
   */
  async sendReadResult(id: number, execId: string | undefined, content: string): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send read result");
    }
    
    console.log("[DEBUG] Sending read result for id:", id);
    
    const execClientMsg = buildExecClientMessageWithReadResult(id, execId, content);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);
    
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;
  }

  /**
   * Result of parsing an InteractionUpdate message
   */
  private parseInteractionUpdate(data: Uint8Array): {
    text: string | null;
    isComplete: boolean;
    toolCallStarted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null;
    toolCallCompleted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null;
    partialToolCall: { callId: string; argsTextDelta: string } | null;
  } {
    const fields = parseProtoFields(data);
    // Log all fields in InteractionUpdate for debugging
    console.log("[DEBUG] InteractionUpdate fields:", fields.map(f => `field${f.fieldNumber}`).join(", "));
    
    let text: string | null = null;
    let isComplete = false;
    let toolCallStarted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null = null;
    let toolCallCompleted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null = null;
    let partialToolCall: { callId: string; argsTextDelta: string } | null = null;
    
    for (const field of fields) {
      // field 1 = text_delta (TextDeltaUpdate)
      if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const innerFields = parseProtoFields(field.value);
        for (const innerField of innerFields) {
          if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
            text = new TextDecoder().decode(innerField.value);
          }
        }
      }
      // field 2 = tool_call_started (ToolCallStartedUpdate)
      else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
        console.log("[DEBUG] Found tool_call_started (field 2)!");
        const parsed = parseToolCallStartedUpdate(field.value);
        if (parsed.toolCall) {
          toolCallStarted = {
            callId: parsed.callId,
            modelCallId: parsed.modelCallId,
            toolType: parsed.toolCall.toolType,
            name: parsed.toolCall.name,
            arguments: JSON.stringify(parsed.toolCall.arguments),
          };
        }
      }
      // field 3 = tool_call_completed (ToolCallCompletedUpdate)
      else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
        console.log("[DEBUG] Found tool_call_completed (field 3)!");
        const parsed = parseToolCallStartedUpdate(field.value); // Same structure as started
        if (parsed.toolCall) {
          toolCallCompleted = {
            callId: parsed.callId,
            modelCallId: parsed.modelCallId,
            toolType: parsed.toolCall.toolType,
            name: parsed.toolCall.name,
            arguments: JSON.stringify(parsed.toolCall.arguments),
          };
        }
      }
      // field 7 = partial_tool_call (PartialToolCallUpdate)
      else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
        console.log("[DEBUG] Found partial_tool_call (field 7)!");
        const parsed = parsePartialToolCallUpdate(field.value);
        partialToolCall = {
          callId: parsed.callId,
          argsTextDelta: parsed.argsTextDelta,
        };
      }
      // field 8 = token_delta (TokenDeltaUpdate)
      else if (field.fieldNumber === 8 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const tokenFields = parseProtoFields(field.value);
        for (const tField of tokenFields) {
          if (tField.fieldNumber === 1 && tField.wireType === 2 && tField.value instanceof Uint8Array) {
            text = new TextDecoder().decode(tField.value);
          }
        }
      }
      // field 14 = turn_ended (TurnEndedUpdate)
      else if (field.fieldNumber === 14) {
        console.log("[DEBUG] Found turn_ended (field 14)!");
        isComplete = true;
      }
    }
    
    return { text, isComplete, toolCallStarted, toolCallCompleted, partialToolCall };
  }

  /**
   * Send a streaming chat request using BidiSse pattern
   */
  async *chatStream(request: AgentChatRequest): AsyncGenerator<AgentStreamChunk> {
    const requestId = randomUUID();
    const messageBody = this.buildChatMessage(request);
    let appendSeqno = 0n;

    // Store for tool result submission
    this.currentRequestId = requestId;
    this.currentAppendSeqno = 0n;

    // Build BidiRequestId message for RunSSE
    const bidiRequestId = encodeBidiRequestId(requestId);
    const envelope = addConnectEnvelope(bidiRequestId);

    // Start the SSE stream
    const sseUrl = `${this.baseUrl}/agent.v1.AgentService/RunSSE`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const ssePromise = fetch(sseUrl, {
        method: "POST",
        headers: this.getHeaders(requestId),
        body: Buffer.from(envelope),
        signal: controller.signal,
      });

      // Send initial message
      await this.bidiAppend(requestId, appendSeqno++, messageBody);
      this.currentAppendSeqno = appendSeqno;

      const sseResponse = await ssePromise;

      if (!sseResponse.ok) {
        clearTimeout(timeout);
        const errorText = await sseResponse.text();
        yield { type: "error", error: `SSE stream failed: ${sseResponse.status} - ${errorText}` };
        return;
      }

      if (!sseResponse.body) {
        clearTimeout(timeout);
        yield { type: "error", error: "No response body from SSE stream" };
        return;
      }

      const reader = sseResponse.body.getReader();
      let buffer = new Uint8Array(0);
      let turnEnded = false;

      try {
        while (!turnEnded) {
          const { done, value } = await reader.read();
          
          if (done) {
            yield { type: "done" };
            break;
          }

          // Append to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          // Parse frames
          let offset = 0;
          while (offset + 5 <= buffer.length) {
            const flags = buffer[offset];
            const length = (buffer[offset + 1]! << 24) |
                          (buffer[offset + 2]! << 16) |
                          (buffer[offset + 3]! << 8) |
                          buffer[offset + 4]!;
            
            if (offset + 5 + length > buffer.length) break;
            
            const frameData = buffer.slice(offset + 5, offset + 5 + length);
            offset += 5 + length;

            // Check for trailer frame
            if ((flags ?? 0) & 0x80) {
              const trailer = new TextDecoder().decode(frameData);
              console.log("Received trailer frame:", trailer.slice(0, 200));
              if (trailer.includes("grpc-status:") && !trailer.includes("grpc-status: 0")) {
                const match = trailer.match(/grpc-message:\s*([^\r\n]+)/);
                const errorMsg = decodeURIComponent(match?.[1] ?? "Unknown gRPC error");
                console.error("gRPC error:", errorMsg);
                yield { type: "error", error: errorMsg };
              }
              continue;
            }

            // Parse AgentServerMessage
            const serverMsgFields = parseProtoFields(frameData);
            console.log("[DEBUG] Server message fields:", serverMsgFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
            
            for (const field of serverMsgFields) {
              try {
                // field 1 = interaction_update
                if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  console.log("[DEBUG] Received interaction_update, length:", field.value.length);
                  const parsed = this.parseInteractionUpdate(field.value);
                  
                  // Yield text content
                  if (parsed.text) {
                    yield { type: "text", content: parsed.text };
                  }
                  
                  // Yield tool call started
                  if (parsed.toolCallStarted) {
                    yield {
                      type: "tool_call_started",
                      toolCall: {
                        callId: parsed.toolCallStarted.callId,
                        modelCallId: parsed.toolCallStarted.modelCallId,
                        toolType: parsed.toolCallStarted.toolType,
                        name: parsed.toolCallStarted.name,
                        arguments: parsed.toolCallStarted.arguments,
                      },
                    };
                  }
                  
                  // Yield tool call completed
                  if (parsed.toolCallCompleted) {
                    yield {
                      type: "tool_call_completed",
                      toolCall: {
                        callId: parsed.toolCallCompleted.callId,
                        modelCallId: parsed.toolCallCompleted.modelCallId,
                        toolType: parsed.toolCallCompleted.toolType,
                        name: parsed.toolCallCompleted.name,
                        arguments: parsed.toolCallCompleted.arguments,
                      },
                    };
                  }
                  
                  // Yield partial tool call updates
                  if (parsed.partialToolCall) {
                    yield {
                      type: "partial_tool_call",
                      toolCall: {
                        callId: parsed.partialToolCall.callId,
                        modelCallId: undefined,
                        toolType: "partial",
                        name: "partial",
                        arguments: "",
                      },
                      partialArgs: parsed.partialToolCall.argsTextDelta,
                    };
                  }
                  
                  if (parsed.isComplete) {
                    turnEnded = true;
                  }
                }
                
                // field 3 = conversation_checkpoint_update (completion signal)
                // NOTE: Checkpoint does NOT mean we're done! exec_server_message can come AFTER checkpoint.
                // Only end on turn_ended (field 14 in interaction_update) or stream close.
                if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  console.log("[DEBUG] Received checkpoint, data length:", field.value.length);
                  // Try to parse checkpoint to see what it contains
                  const checkpointFields = parseProtoFields(field.value);
                  console.log("[DEBUG] Checkpoint fields:", checkpointFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
                  for (const cf of checkpointFields) {
                    if (cf.wireType === 2 && cf.value instanceof Uint8Array) {
                      try {
                        const text = new TextDecoder().decode(cf.value);
                        if (text.length < 200) {
                          console.log(`[DEBUG] Checkpoint field ${cf.fieldNumber}: ${text}`);
                        }
                      } catch {}
                    }
                  }
                  yield { type: "checkpoint" };
                  // DO NOT set turnEnded here - exec messages may follow!
                }
                
                // field 2 = exec_server_message (tool execution request)
                if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  console.log("[DEBUG] Received exec_server_message (field 2), length:", field.value.length);
                  
                  // Parse the ExecServerMessage
                  const execRequest = parseExecServerMessage(field.value);
                  
                  if (execRequest) {
                    // Log based on type
                    if (execRequest.type === 'mcp') {
                      console.log("[DEBUG] Parsed MCP exec request:", {
                        id: execRequest.id,
                        name: execRequest.name,
                        toolName: execRequest.toolName,
                        providerIdentifier: execRequest.providerIdentifier,
                        toolCallId: execRequest.toolCallId,
                        args: execRequest.args,
                      });
                    } else {
                      console.log(`[DEBUG] Parsed ${execRequest.type} exec request:`, execRequest);
                    }
                    
                    // Yield exec_request chunk for the server to handle
                    yield {
                      type: "exec_request",
                      execRequest,
                    };
                  } else {
                    // Log other exec types we don't handle yet
                    const execFields = parseProtoFields(field.value);
                    console.log("[DEBUG] exec_server_message fields (unhandled):", execFields.map(f => `field${f.fieldNumber}`).join(", "));
                  }
                }
                
                // field 4 = kv_server_message
                if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const kvMsg = parseKvServerMessage(field.value);
                  console.log(`[DEBUG] KV message: id=${kvMsg.id}, type=${kvMsg.messageType}, blobId=${kvMsg.blobId ? Buffer.from(kvMsg.blobId).toString('hex').slice(0, 20) : 'none'}...`);
                  appendSeqno = await this.handleKvMessage(kvMsg, requestId, appendSeqno);
                  this.currentAppendSeqno = appendSeqno;
                }
              } catch (parseErr: any) {
                console.error("Error parsing field:", field.fieldNumber, parseErr);
                yield { type: "error", error: `Parse error in field ${field.fieldNumber}: ${parseErr.message}` };
              }
            }
          }
          
          buffer = buffer.slice(offset);
        }

        // Clean exit
        if (turnEnded) {
          controller.abort(); // Clean up the connection
          yield { type: "done" };
        }
      } finally {
        reader.releaseLock();
        clearTimeout(timeout);
        this.currentRequestId = null;
      }
    } catch (err: any) {
      clearTimeout(timeout);
      this.currentRequestId = null;
      if (err.name === 'AbortError') {
        // Normal termination after turn ended
        return;
      }
      console.error("Agent stream error:", err.name, err.message, err.stack);
      yield { type: "error", error: err.message || String(err) };
    }
  }

  /**
   * Send a non-streaming chat request (collects all chunks)
   */
  async chat(request: AgentChatRequest): Promise<string> {
    let result = "";
    
    for await (const chunk of this.chatStream(request)) {
      if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Unknown error");
      }
      if (chunk.type === "text" && chunk.content) {
        result += chunk.content;
      }
    }
    
    return result;
  }
}

/**
 * Create an Agent Service client
 */
export function createAgentServiceClient(
  accessToken: string,
  options?: AgentServiceOptions
): AgentServiceClient {
  return new AgentServiceClient(accessToken, options);
}

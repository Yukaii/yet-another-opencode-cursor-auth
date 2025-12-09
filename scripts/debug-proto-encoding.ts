/**
 * Debug script to compare our protobuf encoding with Cursor CLI's protobuf-es encoding
 */

// Inline encoding utilities (same as in agent-service.ts)
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeVarint(value: number | bigint): Uint8Array {
  const result: number[] = [];
  let v = typeof value === 'bigint' ? value : BigInt(value);
  while (v > 0x7fn) {
    result.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  result.push(Number(v & 0x7fn));
  return new Uint8Array(result);
}

function encodeTagAndWireType(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concatBytes(
    encodeTagAndWireType(fieldNumber, 2),
    encodeVarint(encoded.length),
    encoded
  );
}

function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  return concatBytes(
    encodeTagAndWireType(fieldNumber, 0),
    encodeVarint(value)
  );
}

function encodeMessageField(fieldNumber: number, message: Uint8Array): Uint8Array {
  return concatBytes(
    encodeTagAndWireType(fieldNumber, 2),
    encodeVarint(message.length),
    message
  );
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
 * Build AgentClientMessage with exec_client_control_message
 * AgentClientMessage:
 *   field 5: exec_client_control_message (ExecClientControlMessage)
 */
function buildAgentClientMessageWithExecControl(execClientControlMessage: Uint8Array): Uint8Array {
  return encodeMessageField(5, execClientControlMessage);
}

/**
 * Build a simple McpResult message
 * McpResult:
 *   field 1: success (McpSuccess)
 * McpSuccess:
 *   field 1: result (ContentBlock repeated)
 * ContentBlock:
 *   field 1: text (TextContentBlock)
 * TextContentBlock:
 *   field 1: text (string)
 */
function encodeMcpResult(result: { success?: { content: string; isError?: boolean }; error?: string }): Uint8Array {
  if (result.error) {
    // McpFailure: field 1 = error message
    const mcpFailure = encodeStringField(1, result.error);
    // McpResult field 2 = failure
    return encodeMessageField(2, mcpFailure);
  }

  // TextContentBlock: field 1 = text
  const textBlock = encodeStringField(1, result.success?.content || "");
  // ContentBlock: field 1 = text (TextContentBlock)
  const contentBlock = encodeMessageField(1, textBlock);
  // McpSuccess: field 1 = result (repeated ContentBlock)
  const mcpSuccess = encodeMessageField(1, contentBlock);
  // McpResult: field 1 = success (McpSuccess)
  return encodeMessageField(1, mcpSuccess);
}

/**
 * Build ExecClientMessage with mcp_result
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
 * Build AgentClientMessage with exec_client_message
 */
function buildAgentClientMessageWithExec(execClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(2, execClientMessage);
}

function hexDump(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

function prettyHex(data: Uint8Array): string {
  const hex = hexDump(data);
  let result = '';
  for (let i = 0; i < hex.length; i += 2) {
    result += hex.slice(i, i + 2) + ' ';
  }
  return result.trim();
}

// Test encoding
console.log("=== Test: ExecClientStreamClose (id=1) ===");
const streamClose = encodeExecClientStreamClose(1);
console.log("ExecClientStreamClose:", prettyHex(streamClose));
// Expected for id=1: field 1 (uint32) value 1 = 08 01

console.log("\n=== Test: ExecClientControlMessage with stream_close (id=1) ===");
const controlMsg = buildExecClientControlMessage(1);
console.log("ExecClientControlMessage:", prettyHex(controlMsg));
// Expected: field 1 (LEN) length 2 then {08 01}

console.log("\n=== Test: AgentClientMessage with exec_client_control_message ===");
const agentControlMsg = buildAgentClientMessageWithExecControl(controlMsg);
console.log("AgentClientMessage (control):", prettyHex(agentControlMsg));

console.log("\n=== Test: MCP Result (success with content) ===");
const mcpResult = encodeMcpResult({ success: { content: "test result" } });
console.log("McpResult:", prettyHex(mcpResult));

console.log("\n=== Test: ExecClientMessage with mcp_result ===");
const execClientMsg = buildExecClientMessage(1, "exec-123", { success: { content: "test result" } });
console.log("ExecClientMessage:", prettyHex(execClientMsg));

console.log("\n=== Test: Full AgentClientMessage with exec_client_message ===");
const fullExecMsg = buildAgentClientMessageWithExec(execClientMsg);
console.log("AgentClientMessage (exec):", prettyHex(fullExecMsg));
console.log("As hex string:", hexDump(fullExecMsg));

console.log("\n=== Breakdown Analysis ===");

// Let's also decode and verify our encoding
function parseVarInt(data: Uint8Array, offset: number): { value: number; newOffset: number } {
  let value = 0;
  let shift = 0;
  let byte: number;
  let i = offset;
  do {
    byte = data[i++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte >= 0x80);
  return { value, newOffset: i };
}

function decodeTag(data: Uint8Array, offset: number): { fieldNumber: number; wireType: number; newOffset: number } {
  const { value: tag, newOffset } = parseVarInt(data, offset);
  return {
    fieldNumber: tag >> 3,
    wireType: tag & 0x07,
    newOffset
  };
}

console.log("\nDecoding controlMsg:");
let offset = 0;
const tag1 = decodeTag(controlMsg, offset);
console.log(`  Tag: field=${tag1.fieldNumber}, wireType=${tag1.wireType}`);
offset = tag1.newOffset;
if (tag1.wireType === 2) { // LEN
  const { value: len, newOffset } = parseVarInt(controlMsg, offset);
  console.log(`  Length: ${len}`);
  console.log(`  Content bytes: ${prettyHex(controlMsg.slice(newOffset, newOffset + len))}`);
}

console.log("\nDecoding agentControlMsg:");
offset = 0;
const tag2 = decodeTag(agentControlMsg, offset);
console.log(`  Tag: field=${tag2.fieldNumber}, wireType=${tag2.wireType}`);
offset = tag2.newOffset;
if (tag2.wireType === 2) { // LEN
  const { value: len, newOffset } = parseVarInt(agentControlMsg, offset);
  console.log(`  Length: ${len}`);
  console.log(`  Content bytes: ${prettyHex(agentControlMsg.slice(newOffset, newOffset + len))}`);
}

// Also test shell result encoding
console.log("\n\n=== Test: Shell Result Encoding ===");

function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  return concatBytes(
    encodeTagAndWireType(fieldNumber, 0),
    encodeVarint(value)
  );
}

function encodeShellResult(command: string, cwd: string, stdout: string, stderr: string, exitCode: number, executionTimeMs?: number): Uint8Array {
  // Build ShellSuccess or ShellFailure (same structure)
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

const shellExecMsg = buildExecClientMessageWithShellResult(
  1,               // id
  "exec-456",      // execId
  "ls -la",        // command
  "/tmp",          // cwd
  "file1\nfile2",  // stdout
  "",              // stderr
  0,               // exitCode
  100              // executionTimeMs
);
console.log("ExecClientMessage (shell):", prettyHex(shellExecMsg));
console.log("As hex string:", hexDump(shellExecMsg));

const agentShellMsg = buildAgentClientMessageWithExec(shellExecMsg);
console.log("AgentClientMessage (shell):", prettyHex(agentShellMsg));
console.log("As hex string:", hexDump(agentShellMsg));

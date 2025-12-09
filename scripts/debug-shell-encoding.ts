/**
 * Debug script to verify our manual protobuf encoding is correct
 * by showing exactly what bytes we're sending and what the expected format is
 */

// Our manual encoding functions (copied from agent-service.ts)
function encodeVarint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let v = typeof value === 'bigint' ? value : BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return new Uint8Array(bytes);
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

function encodeFieldKey(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0); // Proto3: default values are omitted
  return concatBytes(
    encodeFieldKey(fieldNumber, 0),
    encodeVarint(value)
  );
}

function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0); // Proto3: default values are omitted
  return concatBytes(
    encodeFieldKey(fieldNumber, 0),
    encodeVarint(value >= 0 ? value : value + 0x100000000)
  );
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  if (value === "") return new Uint8Array(0); // Proto3: default values are omitted
  const bytes = new TextEncoder().encode(value);
  return concatBytes(
    encodeFieldKey(fieldNumber, 2),
    encodeVarint(bytes.length),
    bytes
  );
}

function encodeMessageField(fieldNumber: number, message: Uint8Array): Uint8Array {
  return concatBytes(
    encodeFieldKey(fieldNumber, 2),
    encodeVarint(message.length),
    message
  );
}

// Encode ShellSuccess:
// field 1: command (string)
// field 2: working_directory (string)
// field 3: exit_code (int32)
// field 4: signal (string)
// field 5: stdout (string)
// field 6: stderr (string)
// field 7: execution_time (int32)
function encodeShellSuccess(command: string, cwd: string, stdout: string, stderr: string, exitCode: number, executionTimeMs?: number): Uint8Array {
  return concatBytes(
    encodeStringField(1, command),
    encodeStringField(2, cwd),
    encodeInt32Field(3, exitCode),
    encodeStringField(4, ""),  // signal (empty)
    encodeStringField(5, stdout),
    encodeStringField(6, stderr),
    executionTimeMs ? encodeInt32Field(7, executionTimeMs) : new Uint8Array(0),
  );
}

// ShellResult wraps ShellSuccess in field 1 (success) or field 2 (failure)
function encodeShellResult(command: string, cwd: string, stdout: string, stderr: string, exitCode: number, executionTimeMs?: number): Uint8Array {
  const shellOutcome = encodeShellSuccess(command, cwd, stdout, stderr, exitCode, executionTimeMs);
  const resultField = exitCode === 0 ? 1 : 2;
  return encodeMessageField(resultField, shellOutcome);
}

// ExecClientMessage:
// field 1: id (uint32)
// field 2: shell_result (ShellResult) - oneof message
// field 15: exec_id (string)
function buildExecClientMessageWithShellResult(id: number, execId: string | undefined, shellResult: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(2, shellResult));
  return concatBytes(...parts);
}

// AgentClientMessage with exec_client_message (field 2)
function buildAgentClientMessageWithExec(execClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(2, execClientMessage);
}

// ExecClientStreamClose:
// field 1: id (uint32)
function encodeExecClientStreamClose(id: number): Uint8Array {
  return encodeUint32Field(1, id);
}

// ExecClientControlMessage:
// field 1: stream_close (ExecClientStreamClose) - oneof message
function buildExecClientControlMessage(id: number): Uint8Array {
  const streamClose = encodeExecClientStreamClose(id);
  return encodeMessageField(1, streamClose);
}

// AgentClientMessage with exec_client_control_message (field 5)
function buildAgentClientMessageWithExecControl(controlMessage: Uint8Array): Uint8Array {
  return encodeMessageField(5, controlMessage);
}

function hexDump(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function analyzeProtoBytes(bytes: Uint8Array, indent = "") {
  let offset = 0;
  while (offset < bytes.length) {
    const key = bytes[offset];
    const fieldNumber = key >> 3;
    const wireType = key & 0x7;
    
    offset++;
    if (wireType === 0) {
      // Varint
      let value = 0n;
      let shift = 0n;
      while (offset < bytes.length) {
        const byte = bytes[offset];
        value |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
        offset++;
        if (!(byte & 0x80)) break;
      }
      console.log(`${indent}field ${fieldNumber} (varint): ${value}`);
    } else if (wireType === 2) {
      // Length-delimited
      let length = 0;
      let shift = 0;
      while (offset < bytes.length) {
        const byte = bytes[offset];
        length |= (byte & 0x7f) << shift;
        shift += 7;
        offset++;
        if (!(byte & 0x80)) break;
      }
      const data = bytes.slice(offset, offset + length);
      
      // Try to decode as string
      try {
        const str = new TextDecoder().decode(data);
        if (str.match(/^[\x20-\x7e\n\r\t]*$/) && str.length > 0) {
          console.log(`${indent}field ${fieldNumber} (string, ${length} bytes): "${str}"`);
        } else {
          console.log(`${indent}field ${fieldNumber} (message, ${length} bytes):`);
          analyzeProtoBytes(data, indent + "  ");
        }
      } catch {
        console.log(`${indent}field ${fieldNumber} (bytes, ${length}): ${hexDump(data).slice(0, 40)}...`);
      }
      offset += length;
    } else {
      console.log(`${indent}field ${fieldNumber} (wire type ${wireType}): unknown`);
      break;
    }
  }
}

// Test with sample data
function main() {
  const command = "echo hello";
  const cwd = "/tmp";
  const stdout = "hello\n";
  const stderr = "";
  const exitCode = 0;
  const executionTimeMs = 100;
  const execId = "256b515f-c1d0-469e-a587-3a5a93c628b2";
  const id = 0;

  console.log("=== ShellSuccess encoding ===\n");
  const shellSuccess = encodeShellSuccess(command, cwd, stdout, stderr, exitCode, executionTimeMs);
  console.log("Hex:", hexDump(shellSuccess));
  console.log("Parsed:");
  analyzeProtoBytes(shellSuccess);

  console.log("\n=== ShellResult encoding ===\n");
  const shellResult = encodeShellResult(command, cwd, stdout, stderr, exitCode, executionTimeMs);
  console.log("Hex:", hexDump(shellResult));
  console.log("Parsed:");
  analyzeProtoBytes(shellResult);

  console.log("\n=== ExecClientMessage with shell_result ===\n");
  const execClientMessage = buildExecClientMessageWithShellResult(id, execId, shellResult);
  console.log("Hex:", hexDump(execClientMessage));
  console.log("Parsed:");
  analyzeProtoBytes(execClientMessage);

  console.log("\n=== AgentClientMessage with exec_client_message ===\n");
  const agentClientMessage = buildAgentClientMessageWithExec(execClientMessage);
  console.log("Hex:", hexDump(agentClientMessage));
  console.log("Parsed:");
  analyzeProtoBytes(agentClientMessage);

  console.log("\n=== ExecClientStreamClose ===\n");
  const streamClose = encodeExecClientStreamClose(id);
  console.log("Hex:", hexDump(streamClose));
  console.log("Note: id=0 is omitted in proto3");

  console.log("\n=== ExecClientControlMessage with stream_close ===\n");
  const controlMessage = buildExecClientControlMessage(id);
  console.log("Hex:", hexDump(controlMessage));
  console.log("Parsed:");
  analyzeProtoBytes(controlMessage);

  console.log("\n=== AgentClientMessage with exec_client_control_message ===\n");
  const agentControlMessage = buildAgentClientMessageWithExecControl(controlMessage);
  console.log("Hex:", hexDump(agentControlMessage));
  console.log("Parsed:");
  analyzeProtoBytes(agentControlMessage);

  // Test with id = 1 to show it's not omitted
  console.log("\n=== ExecClientStreamClose with id=1 ===\n");
  const streamClose1 = encodeExecClientStreamClose(1);
  console.log("Hex:", hexDump(streamClose1));
  const controlMessage1 = buildExecClientControlMessage(1);
  console.log("ExecClientControlMessage:", hexDump(controlMessage1));
  console.log("Parsed:");
  analyzeProtoBytes(controlMessage1);
}

main();

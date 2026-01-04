import * as os from "node:os";
import {
  encodeStringField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeMessageField,
  encodeBoolField,
  concatBytes,
} from "./encoding";
import { parseProtoFields, parseProtobufValue } from "./decoding";
import type {
  ExecRequest,
  McpExecRequest,
  ShellExecRequest,
  LsExecRequest,
  ReadExecRequest,
  GrepExecRequest,
  WriteExecRequest,
  McpResult,
  WriteResult,
} from "./types";

function parseShellArgs(data: Uint8Array): { command: string; cwd?: string } {
  const fields = parseProtoFields(data);
  let command = "";
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

function parseReadArgs(data: Uint8Array): { path: string } {
  const fields = parseProtoFields(data);
  let path = "";

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      path = new TextDecoder().decode(field.value);
    }
  }

  return { path };
}

function parseGrepArgs(data: Uint8Array): { pattern: string; path?: string; glob?: string } {
  const fields = parseProtoFields(data);
  let pattern = "";
  let path: string | undefined;
  let glob: string | undefined;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      pattern = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      path = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      glob = new TextDecoder().decode(field.value);
    }
  }

  return { pattern, path, glob };
}

function parseWriteArgs(data: Uint8Array): {
  path: string;
  fileText: string;
  toolCallId?: string;
  returnFileContentAfterWrite?: boolean;
  fileBytes?: Uint8Array;
} {
  const fields = parseProtoFields(data);
  let path = "";
  let fileText = "";
  let toolCallId: string | undefined;
  let returnFileContentAfterWrite: boolean | undefined;
  let fileBytes: Uint8Array | undefined;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      path = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      fileText = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolCallId = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 0) {
      returnFileContentAfterWrite = field.value === 1;
    } else if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
      fileBytes = field.value;
    }
  }

  return { path, fileText, toolCallId, returnFileContentAfterWrite, fileBytes };
}

function parseMcpArgs(data: Uint8Array): Omit<McpExecRequest, "id" | "execId"> {
  const fields = parseProtoFields(data);
  let name = "";
  const args: Record<string, unknown> = {};
  let toolCallId = "";
  let providerIdentifier = "";
  let toolName = "";

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      name = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const entryFields = parseProtoFields(field.value);
      let key = "";
      let value: unknown = undefined;

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

export function parseExecServerMessage(data: Uint8Array): ExecRequest | null {
  const fields = parseProtoFields(data);
  let id = 0;
  let execId: string | undefined = undefined;
  let result: ExecRequest | null = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      id = field.value as number;
    } else if (field.fieldNumber === 15 && field.wireType === 2 && field.value instanceof Uint8Array) {
      execId = new TextDecoder().decode(field.value);
    }
  }

  for (const field of fields) {
    if (field.wireType !== 2 || !(field.value instanceof Uint8Array)) continue;

    switch (field.fieldNumber) {
      case 2:
      case 14: {
        const shellArgs = parseShellArgs(field.value);
        result = { type: "shell", id, execId, command: shellArgs.command, cwd: shellArgs.cwd } as ShellExecRequest;
        break;
      }
      case 3: {
        const writeArgs = parseWriteArgs(field.value);
        result = {
          type: "write",
          id,
          execId,
          path: writeArgs.path,
          fileText: writeArgs.fileText,
          toolCallId: writeArgs.toolCallId,
          returnFileContentAfterWrite: writeArgs.returnFileContentAfterWrite,
          fileBytes: writeArgs.fileBytes,
        } as WriteExecRequest;
        break;
      }
      case 5: {
        const grepArgs = parseGrepArgs(field.value);
        result = { type: "grep", id, execId, pattern: grepArgs.pattern, path: grepArgs.path, glob: grepArgs.glob } as GrepExecRequest;
        break;
      }
      case 7: {
        const readArgs = parseReadArgs(field.value);
        result = { type: "read", id, execId, path: readArgs.path } as ReadExecRequest;
        break;
      }
      case 8: {
        const lsArgs = parseLsArgs(field.value);
        result = { type: "ls", id, execId, path: lsArgs.path } as LsExecRequest;
        break;
      }
      case 10: {
        result = { type: "request_context", id, execId };
        break;
      }
      case 11: {
        const mcpArgs = parseMcpArgs(field.value);
        result = { type: "mcp", id, execId, ...mcpArgs } as McpExecRequest & { type: "mcp" };
        break;
      }
    }

    if (result) break;
  }

  return result;
}

function encodeMcpTextContent(text: string): Uint8Array {
  return encodeStringField(1, text);
}

function encodeMcpToolResultContentItem(text: string): Uint8Array {
  const textContent = encodeMcpTextContent(text);
  return encodeMessageField(1, textContent);
}

function encodeMcpSuccess(content: string, isError = false): Uint8Array {
  const parts: Uint8Array[] = [];
  const contentItem = encodeMcpToolResultContentItem(content);
  parts.push(encodeMessageField(1, contentItem));
  if (isError) {
    parts.push(encodeBoolField(2, true));
  }
  return concatBytes(...parts);
}

function encodeMcpError(error: string): Uint8Array {
  return encodeStringField(1, error);
}

function encodeMcpResult(result: McpResult): Uint8Array {
  if (result.success) {
    const success = encodeMcpSuccess(result.success.content, result.success.isError);
    return encodeMessageField(1, success);
  }
  if (result.error) {
    const error = encodeMcpError(result.error);
    return encodeMessageField(2, error);
  }
  return encodeMessageField(1, encodeMcpSuccess(""));
}

export function buildExecClientMessageWithMcpResult(
  id: number,
  execId: string | undefined,
  result: McpResult
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  const mcpResult = encodeMcpResult(result);
  parts.push(encodeMessageField(11, mcpResult));
  return concatBytes(...parts);
}

function encodeShellResult(
  command: string,
  cwd: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  executionTimeMs?: number
): Uint8Array {
  const shellOutcome = concatBytes(
    encodeStringField(1, command),
    encodeStringField(2, cwd),
    encodeInt32Field(3, exitCode),
    encodeStringField(4, ""),
    encodeStringField(5, stdout),
    encodeStringField(6, stderr),
    executionTimeMs ? encodeInt32Field(7, executionTimeMs) : new Uint8Array(0)
  );
  const resultField = exitCode === 0 ? 1 : 2;
  return encodeMessageField(resultField, shellOutcome);
}

export function buildExecClientMessageWithShellResult(
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

function encodeLsResult(filesString: string): Uint8Array {
  const lsSuccess = encodeStringField(1, filesString);
  return encodeMessageField(1, lsSuccess);
}

export function buildExecClientMessageWithLsResult(
  id: number,
  execId: string | undefined,
  filesString: string
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(8, encodeLsResult(filesString)));
  return concatBytes(...parts);
}

function encodeRequestContextResult(): Uint8Array {
  const cwd = process.cwd();
  const osVersion = `darwin ${os.release()}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shell = process.env.SHELL || "/bin/zsh";

  const env = concatBytes(
    encodeStringField(1, osVersion),
    encodeStringField(2, cwd),
    encodeStringField(3, shell),
    encodeStringField(10, timeZone),
    encodeStringField(11, cwd)
  );

  const requestContext = encodeMessageField(4, env);
  const success = encodeMessageField(1, requestContext);
  return encodeMessageField(1, success);
}

export function buildExecClientMessageWithRequestContextResult(
  id: number,
  execId: string | undefined
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(10, encodeRequestContextResult()));
  return concatBytes(...parts);
}

function encodeReadResult(
  content: string,
  path: string,
  totalLines?: number,
  fileSize?: bigint,
  truncated?: boolean
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeStringField(1, path));
  parts.push(encodeStringField(2, content));
  if (totalLines !== undefined && totalLines > 0) {
    parts.push(encodeInt32Field(3, totalLines));
  }
  if (fileSize !== undefined) {
    parts.push(encodeInt64Field(4, fileSize));
  }
  if (truncated) {
    parts.push(encodeBoolField(6, true));
  }
  const readSuccess = concatBytes(...parts);
  return encodeMessageField(1, readSuccess);
}

export function buildExecClientMessageWithReadResult(
  id: number,
  execId: string | undefined,
  content: string,
  path: string,
  totalLines?: number,
  fileSize?: bigint,
  truncated?: boolean
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(7, encodeReadResult(content, path, totalLines, fileSize, truncated)));
  return concatBytes(...parts);
}

function encodeGrepFilesResult(files: string[], totalFiles: number, truncated = false): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(encodeStringField(1, file));
  }
  parts.push(encodeInt32Field(2, totalFiles));
  if (truncated) {
    parts.push(encodeBoolField(3, true));
  }
  return concatBytes(...parts);
}

function encodeGrepUnionResult(files: string[], totalFiles: number, truncated = false): Uint8Array {
  const filesResult = encodeGrepFilesResult(files, totalFiles, truncated);
  return encodeMessageField(2, filesResult);
}

function encodeGrepSuccess(pattern: string, path: string, files: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeStringField(1, pattern));
  parts.push(encodeStringField(2, path));
  parts.push(encodeStringField(3, "files_with_matches"));
  const unionResult = encodeGrepUnionResult(files, files.length);
  const mapEntry = concatBytes(encodeStringField(1, path), encodeMessageField(2, unionResult));
  parts.push(encodeMessageField(4, mapEntry));
  return concatBytes(...parts);
}

function encodeGrepResult(pattern: string, path: string, files: string[]): Uint8Array {
  const success = encodeGrepSuccess(pattern, path, files);
  return encodeMessageField(1, success);
}

export function buildExecClientMessageWithGrepResult(
  id: number,
  execId: string | undefined,
  pattern: string,
  path: string,
  files: string[]
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(5, encodeGrepResult(pattern, path, files)));
  return concatBytes(...parts);
}

function encodeWriteSuccess(
  path: string,
  linesCreated: number,
  fileSize: number,
  fileContentAfterWrite?: string
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeStringField(1, path));
  parts.push(encodeInt32Field(2, linesCreated));
  parts.push(encodeInt32Field(3, fileSize));
  if (fileContentAfterWrite) {
    parts.push(encodeStringField(4, fileContentAfterWrite));
  }
  return concatBytes(...parts);
}

function encodeWriteError(path: string, error: string): Uint8Array {
  return concatBytes(encodeStringField(1, path), encodeStringField(2, error));
}

function encodeWriteResult(result: WriteResult): Uint8Array {
  if (result.success) {
    const success = encodeWriteSuccess(
      result.success.path,
      result.success.linesCreated,
      result.success.fileSize,
      result.success.fileContentAfterWrite
    );
    return encodeMessageField(1, success);
  }
  if (result.error) {
    const error = encodeWriteError(result.error.path, result.error.error);
    return encodeMessageField(5, error);
  }
  return encodeMessageField(1, encodeWriteSuccess("", 0, 0));
}

export function buildExecClientMessageWithWriteResult(
  id: number,
  execId: string | undefined,
  result: WriteResult
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeUint32Field(1, id));
  if (execId) {
    parts.push(encodeStringField(15, execId));
  }
  parts.push(encodeMessageField(3, encodeWriteResult(result)));
  return concatBytes(...parts);
}

export function buildAgentClientMessageWithExec(execClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(2, execClientMessage);
}

function encodeExecClientStreamClose(id: number): Uint8Array {
  return encodeUint32Field(1, id);
}

export function buildExecClientControlMessage(id: number): Uint8Array {
  const streamClose = encodeExecClientStreamClose(id);
  return encodeMessageField(1, streamClose);
}

export function buildAgentClientMessageWithExecControl(execClientControlMessage: Uint8Array): Uint8Array {
  return encodeMessageField(5, execClientControlMessage);
}

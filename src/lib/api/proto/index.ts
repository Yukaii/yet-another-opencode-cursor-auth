export {
  encodeVarint,
  encodeStringField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeMessageField,
  encodeBoolField,
  encodeDoubleField,
  concatBytes,
  encodeProtobufValue,
  hexDump,
} from "./encoding";

export {
  decodeVarint,
  parseProtoFields,
  parseProtobufValue,
  parseProtobufStruct,
  parseProtobufListValue,
} from "./decoding";

export type { ParsedField } from "./decoding";

export {
  AgentMode,
} from "./types";

export type {
  OpenAIToolDefinition,
  McpExecRequest,
  ShellExecRequest,
  LsExecRequest,
  ReadExecRequest,
  GrepExecRequest,
  WriteExecRequest,
  ExecRequest,
  KvServerMessage,
  ToolCallInfo,
  ParsedToolCall,
  ParsedToolCallStarted,
  ParsedPartialToolCall,
  AgentStreamChunk,
  ChatTimingMetrics,
  AgentServiceOptions,
  AgentChatRequest,
  McpResult,
  ShellOutcome,
  WriteResult,
  BlobAnalysis,
  ParsedInteractionUpdate,
} from "./types";

export {
  parseExecServerMessage,
  buildExecClientMessageWithMcpResult,
  buildExecClientMessageWithShellResult,
  buildExecClientMessageWithLsResult,
  buildExecClientMessageWithRequestContextResult,
  buildExecClientMessageWithReadResult,
  buildExecClientMessageWithGrepResult,
  buildExecClientMessageWithWriteResult,
  buildAgentClientMessageWithExec,
  buildExecClientControlMessage,
  buildAgentClientMessageWithExecControl,
} from "./exec";

export {
  TOOL_FIELD_MAP,
  TOOL_ARG_SCHEMA,
  parseToolCall,
  parseToolCallStartedUpdate,
  parsePartialToolCallUpdate,
} from "./tool-calls";

export {
  parseKvServerMessage,
  buildKvClientMessage,
  buildAgentClientMessageWithKv,
} from "./kv";

export {
  encodeBidiRequestId,
  encodeBidiAppendRequest,
} from "./bidi";

export {
  encodeMcpToolDefinition,
  buildRequestContextEnv,
  encodeMcpInstructions,
  buildRequestContext,
  encodeUserMessage,
  encodeUserMessageAction,
  encodeConversationAction,
  encodeModelDetails,
  encodeEmptyConversationState,
  encodeMcpTools,
  encodeMcpDescriptor,
  encodeMcpFileSystemOptions,
  encodeAgentRunRequest,
  encodeAgentClientMessage,
} from "./agent-messages";

export type { McpDescriptorInput } from "./agent-messages";

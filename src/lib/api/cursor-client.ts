/**
 * Cursor API Client
 *
 * Implements the Cursor API communication using the Connect-RPC protocol.
 * This is a simplified implementation that handles chat completions.
 */

import { randomUUID, createHash } from "node:crypto";

// --- Constants ---

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CHAT_ENDPOINT = "/aiserver.v1.AiService/StreamChat";

// --- Types ---

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponseDelta {
  content: string;
  finishReason?: string;
}

export interface StreamChunk {
  type: "delta" | "done" | "error";
  content?: string;
  error?: string;
}

// Role mapping for protobuf: user=1, assistant=2, system=3
const ROLE_MAP: Record<string, number> = {
  user: 1,
  assistant: 2,
  system: 3,
};

// --- Protobuf Helpers ---

/**
 * Encode a varint (variable-length integer)
 */
function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 127) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return new Uint8Array(bytes);
}

/**
 * Encode a string field in protobuf format
 * Field format: (field_number << 3) | wire_type
 * String wire type = 2
 */
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

/**
 * Encode an int32 field in protobuf format
 * Wire type = 0 (varint)
 */
function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  const encoded = encodeVarint(value);
  
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  
  return result;
}

/**
 * Encode a nested message field
 */
function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 2; // wire type 2 = length-delimited
  const length = encodeVarint(data.length);
  
  const result = new Uint8Array(1 + length.length + data.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(data, 1 + length.length);
  
  return result;
}

/**
 * Concatenate multiple Uint8Arrays
 */
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

// --- Cursor Message Encoding ---

/**
 * Encode a single user message for the Cursor API
 * 
 * Message structure (based on OpenCursor's message.proto):
 * - content: field 1 (string)
 * - role: field 2 (int32)
 * - messageId: field 13 (string)
 */
function encodeUserMessage(message: ChatMessage, messageId: string): Uint8Array {
  return concatBytes(
    encodeStringField(1, message.content),
    encodeInt32Field(2, ROLE_MAP[message.role] ?? 1),
    encodeStringField(13, messageId)
  );
}

/**
 * Encode instructions (system prompt)
 * - instruction: field 1 (string)
 */
function encodeInstructions(systemPrompt: string): Uint8Array {
  return encodeStringField(1, systemPrompt);
}

/**
 * Encode model info
 * - name: field 1 (string)
 * - empty: field 4 (string) - always empty
 */
function encodeModel(modelName: string): Uint8Array {
  return concatBytes(
    encodeStringField(1, modelName),
    encodeStringField(4, "")
  );
}

/**
 * Encode a complete ChatMessage for the Cursor API
 * 
 * ChatMessage structure:
 * - messages: field 2 (repeated UserMessage)
 * - instructions: field 4 (Instructions)
 * - projectPath: field 5 (string)
 * - model: field 7 (Model)
 * - requestId: field 9 (string)
 * - summary: field 11 (string)
 * - conversationId: field 15 (string)
 */
export function encodeChatRequest(request: ChatRequest): Uint8Array {
  const requestId = randomUUID();
  const conversationId = randomUUID();
  
  // Find system message for instructions
  const systemMessage = request.messages.find(m => m.role === "system");
  const chatMessages = request.messages.filter(m => m.role !== "system");
  
  // Encode all user/assistant messages
  const encodedMessages = chatMessages.map((msg) => 
    encodeMessageField(2, encodeUserMessage(msg, randomUUID()))
  );
  
  // Encode instructions if present
  const encodedInstructions = systemMessage
    ? encodeMessageField(4, encodeInstructions(systemMessage.content))
    : new Uint8Array(0);
  
  // Encode model
  const encodedModel = encodeMessageField(7, encodeModel(request.model));
  
  // Combine all fields
  const messageBody = concatBytes(
    ...encodedMessages,
    encodedInstructions,
    encodeStringField(5, "/project"),
    encodedModel,
    encodeStringField(9, requestId),
    encodeStringField(11, ""),
    encodeStringField(15, conversationId)
  );
  
  return messageBody;
}

/**
 * Add Connect-RPC envelope (5-byte header)
 * Format: [flags: 1 byte][length: 4 bytes big-endian][payload]
 */
export function addConnectEnvelope(data: Uint8Array, flags: number = 0): Uint8Array {
  const result = new Uint8Array(5 + data.length);
  result[0] = flags;
  result[1] = (data.length >> 24) & 0xff;
  result[2] = (data.length >> 16) & 0xff;
  result[3] = (data.length >> 8) & 0xff;
  result[4] = data.length & 0xff;
  result.set(data, 5);
  return result;
}

// --- Response Decoding ---

/**
 * Decode a varint from a buffer
 */
function decodeVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  
  return { value, bytesRead };
}

/**
 * Decode a string from protobuf data
 */
function decodeString(data: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(data.slice(offset, offset + length));
}

/**
 * Decode a ResMessage from protobuf
 * ResMessage: msg is field 1 (string)
 */
function decodeResMessage(data: Uint8Array): string {
  let offset = 0;
  let result = "";
  
  while (offset < data.length) {
    const fieldInfo = decodeVarint(data, offset);
    offset += fieldInfo.bytesRead;
    
    const fieldNumber = fieldInfo.value >> 3;
    const wireType = fieldInfo.value & 0x7;
    
    if (wireType === 2) { // length-delimited
      const lengthInfo = decodeVarint(data, offset);
      offset += lengthInfo.bytesRead;
      
      if (fieldNumber === 1) { // msg field
        result = decodeString(data, offset, lengthInfo.value);
      }
      offset += lengthInfo.value;
    } else if (wireType === 0) { // varint
      const valueInfo = decodeVarint(data, offset);
      offset += valueInfo.bytesRead;
    } else {
      // Unknown wire type, try to skip
      break;
    }
  }
  
  return result;
}

/**
 * Parse Connect-RPC streaming response chunks
 */
export function parseStreamChunks(buffer: Uint8Array): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  let offset = 0;
  
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = (buffer[offset + 1] << 24) |
                   (buffer[offset + 2] << 16) |
                   (buffer[offset + 3] << 8) |
                   buffer[offset + 4];
    
    offset += 5;
    
    if (offset + length > buffer.length) {
      break;
    }
    
    const messageData = buffer.slice(offset, offset + length);
    offset += length;
    
    // Check for error flag (0x02)
    if (flags === 0x02) {
      try {
        const errorText = new TextDecoder().decode(messageData);
        chunks.push({ type: "error", error: errorText });
      } catch {
        chunks.push({ type: "error", error: "Unknown error" });
      }
      continue;
    }
    
    // Normal message - decode as ResMessage
    try {
      const content = decodeResMessage(messageData);
      if (content) {
        chunks.push({ type: "delta", content });
      }
    } catch {
      // Skip malformed messages
    }
  }
  
  return chunks;
}

// --- Checksum Generation ---

/**
 * Generate checksum for Cursor API requests
 * Based on OpenCursor's implementation
 */
export function generateChecksum(token: string): string {
  const salt = token.split(".");
  
  // XOR-based obfuscation
  const calc = (data: Buffer): void => {
    let t = 165;
    for (let i = 0; i < data.length; i++) {
      data[i] = (data[i] ^ t) + i;
      t = data[i];
    }
  };
  
  // Timestamp rounded to 30-minute intervals
  const now = new Date();
  now.setMinutes(30 * Math.floor(now.getMinutes() / 30), 0, 0);
  const timestamp = Math.floor(now.getTime() / 1e6);
  
  // Create timestamp buffer
  const timestampBuffer = Buffer.alloc(6);
  let temp = timestamp;
  for (let i = 5; i >= 0; i--) {
    timestampBuffer[i] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }
  calc(timestampBuffer);
  
  // SHA-256 hashes
  const calcHex = (input: string): string => {
    return createHash("sha256").update(input).digest("hex").slice(0, 8);
  };
  
  const hex1 = salt[1] ? calcHex(salt[1]) : "00000000";
  const hex2 = calcHex(token);
  
  return `${timestampBuffer.toString("base64url")}${hex1}/${hex2}`;
}

// --- Cursor API Client ---

export interface CursorClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class CursorClient {
  private baseUrl: string;
  private accessToken: string;
  private headers: Record<string, string>;
  
  constructor(accessToken: string, options: CursorClientOptions = {}) {
    this.accessToken = accessToken;
    this.baseUrl = options.baseUrl ?? CURSOR_API_URL;
    this.headers = options.headers ?? {};
  }

  /**
   * Expose the configured base URL (needed for ancillary Cursor calls).
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }
  
  /**
   * Get request headers for Cursor API
   */
  private getHeaders(): Record<string, string> {
    const checksum = generateChecksum(this.accessToken);
    
    return {
      "authorization": `Bearer ${this.accessToken}`,
      "content-type": "application/connect+proto",
      "connect-accept-encoding": "gzip,br",
      "connect-protocol-version": "1",
      "user-agent": "connect-es/1.4.0",
      "x-cursor-checksum": checksum,
      "x-cursor-client-version": "0.42.3",
      "x-cursor-client-type": "cli",
      "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      "x-ghost-mode": "true",
      "x-request-id": randomUUID(),
      "host": new URL(this.baseUrl).host,
      ...this.headers,
    };
  }

  /**
   * Build request headers with optional overrides.
   */
  buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.getHeaders(), ...extra };
  }
  
  /**
   * Send a chat completion request (non-streaming)
   */
  async chat(request: ChatRequest): Promise<string> {
    const messageBody = encodeChatRequest(request);
    const envelope = addConnectEnvelope(messageBody);
    
    const response = await fetch(`${this.baseUrl}${CURSOR_CHAT_ENDPOINT}`, {
      method: "POST",
      headers: this.getHeaders(),
      body: Buffer.from(envelope),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cursor API error: ${response.status} - ${errorText}`);
    }
    
    const buffer = new Uint8Array(await response.arrayBuffer());
    const chunks = parseStreamChunks(buffer);
    
    // Combine all content
    let result = "";
    for (const chunk of chunks) {
      if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Unknown error");
      }
      if (chunk.type === "delta" && chunk.content) {
        result += chunk.content;
      }
    }
    
    return result;
  }
  
  /**
   * Send a streaming chat completion request
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const messageBody = encodeChatRequest(request);
    const envelope = addConnectEnvelope(messageBody);
    
    const response = await fetch(`${this.baseUrl}${CURSOR_CHAT_ENDPOINT}`, {
      method: "POST",
      headers: this.getHeaders(),
      body: Buffer.from(envelope),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cursor API error: ${response.status} - ${errorText}`);
    }
    
    if (!response.body) {
      throw new Error("No response body");
    }
    
    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          // Process remaining buffer
          if (buffer.length > 0) {
            const chunks = parseStreamChunks(buffer);
            for (const chunk of chunks) {
              yield chunk;
            }
          }
          yield { type: "done" };
          break;
        }
        
        // Append to buffer
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;
        
        // Try to parse complete messages
        const chunks = parseStreamChunks(buffer);
        for (const chunk of chunks) {
          yield chunk;
        }
        
        // Note: In a production implementation, we'd track how much was consumed
        // and keep the remaining partial message in the buffer
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Create a Cursor API client
 */
export function createCursorClient(
  accessToken: string,
  options?: CursorClientOptions
): CursorClient {
  return new CursorClient(accessToken, options);
}

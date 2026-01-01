/**
 * KV (Key-Value) Message Handling
 *
 * Handles blob storage operations requested by the Cursor Agent:
 * - get_blob_args: Request to retrieve a stored blob
 * - set_blob_args: Request to store a blob
 *
 * Proto structure:
 * KvServerMessage:
 *   field 1: id (uint32) - message ID to include in response
 *   field 2: get_blob_args (GetBlobArgs)
 *   field 3: set_blob_args (SetBlobArgs)
 *
 * KvClientMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_result (GetBlobResult)
 *   field 3: set_blob_result (SetBlobResult)
 */

import { parseProtoFields } from "./decoding";
import { encodeUint32Field, encodeMessageField, concatBytes } from "./encoding";
import type { KvServerMessage } from "./types";

// Re-export type for convenience
export type { KvServerMessage };

/**
 * Parse KvServerMessage from protobuf bytes
 *
 * KvServerMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_args (GetBlobArgs) - contains blob_id
 *   field 3: set_blob_args (SetBlobArgs) - contains blob_id and blob_data
 */
export function parseKvServerMessage(data: Uint8Array): KvServerMessage {
  const fields = parseProtoFields(data);
  const result: KvServerMessage = { id: 0, messageType: 'unknown' };

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = field.value as number;
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      // get_blob_args
      result.messageType = 'get_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        }
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      // set_blob_args
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

/**
 * Build KvClientMessage
 *
 * KvClientMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_result (GetBlobResult)
 *   field 3: set_blob_result (SetBlobResult)
 */
export function buildKvClientMessage(
  id: number,
  resultType: 'get_blob_result' | 'set_blob_result',
  result: Uint8Array
): Uint8Array {
  const fieldNumber = resultType === 'get_blob_result' ? 2 : 3;
  return concatBytes(
    encodeUint32Field(1, id),
    encodeMessageField(fieldNumber, result)
  );
}

/**
 * Build AgentClientMessage with kv_client_message
 *
 * AgentClientMessage:
 *   field 3: kv_client_message (KvClientMessage)
 */
export function buildAgentClientMessageWithKv(kvClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(3, kvClientMessage);
}

import type { BlobAnalysis } from "./types";

export function analyzeBlobData(data: Uint8Array): BlobAnalysis {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return { type: 'json', json, text };
    } catch {
      return { type: 'text', text };
    }
  } catch { }

  try {
    const fields = parseProtoFields(data);
    if (fields.length > 0 && fields.length < 100) {
      const protoFields: BlobAnalysis["protoFields"] = [];
      for (const f of fields) {
        const entry: { num: number; wire: number; size: number; text?: string } = {
          num: f.fieldNumber,
          wire: f.wireType,
          size: f.value instanceof Uint8Array ? f.value.length : 0,
        };
        if (f.wireType === 2 && f.value instanceof Uint8Array) {
          try {
            entry.text = new TextDecoder('utf-8', { fatal: true }).decode(f.value);
          } catch { }
        }
        protoFields.push(entry);
      }
      return { type: 'protobuf', protoFields };
    }
  } catch { }

  return { type: 'binary' };
}

export interface AssistantBlobContent {
  blobId: string;
  content: string;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  type?: unknown;
  text?: unknown;
  messages?: unknown[];
}

export function extractAssistantContent(
  blobAnalysis: BlobAnalysis,
  blobKey: string
): AssistantBlobContent[] {
  const results: AssistantBlobContent[] = [];

  if (blobAnalysis.type === 'json' && blobAnalysis.json) {
    const json = blobAnalysis.json as MessageLike;
    
    if (json.role === "assistant") {
      const content = json.content;
      if (typeof content === "string" && content.length > 0) {
        results.push({ blobId: blobKey, content });
      } else if (Array.isArray(content)) {
        for (const part of content as MessageLike[]) {
          if (typeof part === 'string') {
            results.push({ blobId: blobKey, content: part });
          } else if (part?.type === 'text' && typeof part?.text === 'string') {
            results.push({ blobId: blobKey, content: part.text });
          }
        }
      }
    }
    
    if (Array.isArray(json.messages)) {
      for (const msg of json.messages as MessageLike[]) {
        if (msg?.role === "assistant" && typeof msg?.content === "string") {
          results.push({ blobId: blobKey, content: msg.content });
        }
      }
    }
  } else if (blobAnalysis.type === 'protobuf' && blobAnalysis.protoFields) {
    for (const field of blobAnalysis.protoFields) {
      if (field.text && field.text.length > 50 && !field.text.startsWith('{') && !field.text.startsWith('[')) {
        results.push({ blobId: `${blobKey}:f${field.num}`, content: field.text });
      }
    }
  }

  return results;
}

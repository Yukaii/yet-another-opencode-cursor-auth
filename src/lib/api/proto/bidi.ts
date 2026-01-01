/**
 * BidiSse Protocol Encoding
 * 
 * Handles encoding of Bidi stream messages for Cursor's SSE-based protocol.
 */

import {
  encodeStringField,
  encodeMessageField,
  encodeInt64Field,
  concatBytes,
} from "./encoding";

/**
 * Encode BidiRequestId
 * - request_id: field 1 (string)
 */
export function encodeBidiRequestId(requestId: string): Uint8Array {
  return encodeStringField(1, requestId);
}

/**
 * Encode BidiAppendRequest
 * - data: field 1 (string, hex-encoded)
 * - request_id: field 2 (BidiRequestId message)
 * - append_seqno: field 3 (int64)
 */
export function encodeBidiAppendRequest(data: string, requestId: string, appendSeqno: bigint): Uint8Array {
  const requestIdMsg = encodeBidiRequestId(requestId);
  return concatBytes(
    encodeStringField(1, data),
    encodeMessageField(2, requestIdMsg),
    encodeInt64Field(3, appendSeqno)
  );
}

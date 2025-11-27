/**
 * JWT Utilities
 *
 * Provides functions for decoding and validating JWT tokens.
 * NOTE: These functions do NOT verify signatures - they are for
 * expiration checking and display purposes only.
 */

export interface JwtPayload {
  sub?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

/**
 * Decode JWT payload without signature verification.
 * ONLY for expiration checking and display purposes.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const base64Payload = parts[1];
    if (!base64Payload) return null;

    // Handle base64url encoding
    const base64 = base64Payload.replace(/-/g, "+").replace(/_/g, "/");
    const payloadBuffer = Buffer.from(base64, "base64");
    return JSON.parse(payloadBuffer.toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * Check if a token is expiring soon (within threshold seconds).
 * Default threshold is 5 minutes (300 seconds).
 */
export function isTokenExpiringSoon(
  token: string,
  thresholdSeconds = 300
): boolean {
  try {
    const decoded = decodeJwtPayload(token);
    if (!decoded || typeof decoded.exp !== "number") return true;

    const currentTime = Math.floor(Date.now() / 1000);
    const expirationTime = decoded.exp;
    const timeLeft = expirationTime - currentTime;

    return timeLeft < thresholdSeconds;
  } catch {
    return true;
  }
}

/**
 * Check if a token has expired.
 */
export function isTokenExpired(token: string): boolean {
  try {
    const decoded = decodeJwtPayload(token);
    if (!decoded || typeof decoded.exp !== "number") return true;

    const currentTime = Math.floor(Date.now() / 1000);
    return decoded.exp < currentTime;
  } catch {
    return true;
  }
}

/**
 * Get the time remaining until token expiration in seconds.
 * Returns negative value if expired.
 */
export function getTokenTimeRemaining(token: string): number {
  try {
    const decoded = decodeJwtPayload(token);
    if (!decoded || typeof decoded.exp !== "number") return -1;

    const currentTime = Math.floor(Date.now() / 1000);
    return decoded.exp - currentTime;
  } catch {
    return -1;
  }
}

/**
 * Format seconds into human-readable duration.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return "expired";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Mask sensitive token data for display.
 */
export function maskToken(token: string | undefined): string {
  if (!token) return "(not set)";
  if (token.length < 20) return "***";
  return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
}

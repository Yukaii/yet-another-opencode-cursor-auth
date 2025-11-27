/**
 * Login Manager
 *
 * Handles the OAuth PKCE login flow and API key authentication
 * for Cursor's authentication system.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { platform } from "node:os";
import { exec } from "node:child_process";

// --- Configuration ---

export const CURSOR_WEBSITE_URL = "https://cursor.com";
export const CURSOR_API_BASE_URL = "https://api2.cursor.sh";
export const POLLING_ENDPOINT = `${CURSOR_API_BASE_URL}/auth/poll`;

// --- Types ---

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
}

export interface AuthParams {
  uuid: string;
  challenge: string;
  verifier: string;
  loginUrl: string;
}

export interface LoginMetadata {
  uuid: string;
  verifier: string;
}

// --- Helper Functions ---

/**
 * Base64 URL encode a buffer (RFC 4648)
 */
function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Generate a SHA-256 hash of the input string
 */
function sha256(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Generate authentication parameters (PKCE flow)
 */
export function generateAuthParams(): AuthParams {
  // Generate a 32-byte random verifier
  const verifierArray = randomBytes(32);
  const verifier = base64URLEncode(verifierArray);

  // Generate challenge by SHA-256 hashing the verifier
  const challengeHash = sha256(verifier);
  const challenge = base64URLEncode(challengeHash);

  // Generate a UUID
  const uuid = randomUUID();

  // Construct the login URL
  const loginUrl = `${CURSOR_WEBSITE_URL}/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli`;

  return {
    uuid,
    challenge,
    verifier,
    loginUrl,
  };
}

/**
 * Open a URL in the default browser
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command =
      platform() === "darwin"
        ? `open "${url}"`
        : platform() === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;

    exec(command, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- LoginManager ---

export class LoginManager {
  /**
   * Start the OAuth login flow
   * Returns metadata needed for polling and the URL to open in browser
   */
  startLogin(): { metadata: LoginMetadata; loginUrl: string } {
    const authParams = generateAuthParams();
    return {
      metadata: {
        uuid: authParams.uuid,
        verifier: authParams.verifier,
      },
      loginUrl: authParams.loginUrl,
    };
  }

  /**
   * Poll for authentication result
   * This waits for the user to complete the browser login
   */
  async waitForResult(
    metadata: LoginMetadata,
    options?: {
      maxAttempts?: number;
      onProgress?: (attempt: number) => void;
    }
  ): Promise<AuthResult | null> {
    const maxAttempts = options?.maxAttempts ?? 150;
    const baseDelay = 1000; // 1 second base delay
    const maxDelay = 10000; // 10 seconds maximum delay
    const backoffMultiplier = 1.2; // Gentle exponential backoff
    const maxConsecutiveErrors = 3;

    let consecutiveErrors = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const url = `${POLLING_ENDPOINT}?uuid=${metadata.uuid}&verifier=${metadata.verifier}`;
        const response = await fetch(url, {
          headers: {
            "Content-Type": "application/json",
          },
        });

        // 404 means authentication is still pending
        if (response.status === 404) {
          consecutiveErrors = 0;
          const delay = Math.min(
            baseDelay * Math.pow(backoffMultiplier, attempt),
            maxDelay
          );
          options?.onProgress?.(attempt);
          await sleep(delay);
          continue;
        }

        // Check for other error statuses
        if (!response.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            return null;
          }
          const delay = Math.min(
            baseDelay * Math.pow(backoffMultiplier, attempt),
            maxDelay
          );
          await sleep(delay);
          continue;
        }

        // Success case
        consecutiveErrors = 0;
        const authResult = await response.json();

        if (
          typeof authResult === "object" &&
          authResult !== null &&
          "accessToken" in authResult &&
          "refreshToken" in authResult
        ) {
          return authResult as AuthResult;
        }

        return null;
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          return null;
        }
        const delay = Math.min(
          baseDelay * Math.pow(backoffMultiplier, attempt),
          maxDelay
        );
        await sleep(delay);
      }
    }

    return null;
  }

  /**
   * Exchange API key for access/refresh tokens
   */
  async loginWithApiKey(
    apiKey: string,
    options?: { endpoint?: string }
  ): Promise<AuthResult | null> {
    const baseUrl = options?.endpoint ?? CURSOR_API_BASE_URL;

    try {
      const response = await fetch(`${baseUrl}/auth/exchange_user_api_key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        return null;
      }

      const authResult = await response.json();

      if (
        typeof authResult === "object" &&
        authResult !== null &&
        "accessToken" in authResult &&
        "refreshToken" in authResult
      ) {
        return authResult as AuthResult;
      }
    } catch {
      // API key exchange error
    }

    return null;
  }
}

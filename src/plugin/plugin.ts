/**
 * OpenCode Cursor Auth Plugin
 *
 * An OpenCode plugin that provides OAuth authentication for Cursor's AI backend,
 * following the architecture established by opencode-gemini-auth.
 */

import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { platform } from "node:os";

import {
  LoginManager,
  CURSOR_API_BASE_URL,
} from "../lib/auth/login";
import { decodeJwtPayload } from "../lib/utils/jwt";
import { refreshAccessToken } from "../lib/auth/helpers";
import type {
  PluginContext,
  PluginResult,
  GetAuth,
  Provider,
  LoaderResult,
  OAuthAuthDetails,
  TokenExchangeResult,
  AuthDetails,
} from "./types";

// --- Constants ---

export const CURSOR_PROVIDER_ID = "cursor";

const CURSOR_CLIENT_HEADERS = {
  "x-cursor-client-version": "opencode-cursor-auth/0.1.0",
  "x-cursor-client-type": "cli",
  "x-ghost-mode": "true",
} as const;

// --- Auth Helpers ---

/**
 * Check if auth details are OAuth type
 */
function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === "oauth";
}

/**
 * Check if access token has expired or is missing
 */
function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== "number") {
    return true;
  }
  // Add 60 second buffer
  return auth.expires <= Date.now() + 60 * 1000;
}

/**
 * Parse stored refresh token parts (format: "refreshToken|apiKey")
 */
function parseRefreshParts(refresh: string): {
  refreshToken: string;
  apiKey?: string;
} {
  const [refreshToken = "", apiKey = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    apiKey: apiKey || undefined,
  };
}

/**
 * Format refresh token parts for storage
 */
function formatRefreshParts(refreshToken: string, apiKey?: string): string {
  return apiKey ? `${refreshToken}|${apiKey}` : refreshToken;
}

/**
 * Refresh an access token using the refresh token
 */
async function refreshCursorAccessToken(
  auth: OAuthAuthDetails,
  client: PluginContext["client"]
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  try {
    const result = await refreshAccessToken(
      parts.refreshToken,
      CURSOR_API_BASE_URL
    );

    if (!result) {
      return undefined;
    }

    const updatedAuth: OAuthAuthDetails = {
      type: "oauth",
      refresh: formatRefreshParts(result.refreshToken, parts.apiKey),
      access: result.accessToken,
      expires: Date.now() + 3600 * 1000, // 1 hour default
    };

    // Try to get actual expiration from token
    const payload = decodeJwtPayload(result.accessToken);
    if (payload?.exp && typeof payload.exp === "number") {
      updatedAuth.expires = payload.exp * 1000;
    }

    // Persist the updated auth
    try {
      await client.auth.set({
        path: { id: CURSOR_PROVIDER_ID },
        body: updatedAuth,
      });
    } catch (e) {
      console.error("Failed to persist refreshed Cursor credentials:", e);
    }

    return updatedAuth;
  } catch (error) {
    console.error("Failed to refresh Cursor access token:", error);
    return undefined;
  }
}

// --- Request Handling ---

/**
 * Check if a request is targeting Cursor's API
 */
function isCursorApiRequest(input: RequestInfo): boolean {
  const url = typeof input === "string" ? input : (input as Request).url;
  return (
    url.includes("cursor.sh") ||
    url.includes("api.cursor.com") ||
    url.includes("openai.com") // Cursor uses OpenAI-compatible endpoints
  );
}

/**
 * Prepare request with Cursor auth headers
 */
function prepareCursorRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string
): { request: RequestInfo; init: RequestInit } {
  const headers = new Headers(init?.headers ?? {});

  // Set authorization
  headers.set("Authorization", `Bearer ${accessToken}`);

  // Set Cursor-specific headers
  for (const [key, value] of Object.entries(CURSOR_CLIENT_HEADERS)) {
    headers.set(key, value);
  }

  // Add request ID if not present
  if (!headers.has("x-request-id")) {
    headers.set("x-request-id", randomUUID());
  }

  return {
    request: input,
    init: {
      ...init,
      headers,
    },
  };
}

// --- OAuth Flow Helpers ---

/**
 * Open a URL in the default browser
 */
function openBrowser(url: string): Promise<void> {
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

// --- Main Plugin ---

/**
 * Cursor OAuth Plugin for OpenCode
 *
 * Provides authentication for Cursor's AI backend using:
 * - Browser-based OAuth flow with PKCE
 * - API key authentication
 * - Automatic token refresh
 */
export const CursorOAuthPlugin = async ({
  client,
}: PluginContext): Promise<PluginResult> => ({
  auth: {
    provider: CURSOR_PROVIDER_ID,

    loader: async (
      getAuth: GetAuth,
      provider: Provider
    ): Promise<LoaderResult | null> => {
      const auth = await getAuth();

      if (!isOAuthAuth(auth)) {
        return null;
      }

      // Set model costs to 0 (Cursor handles billing)
      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (model) {
            model.cost = { input: 0, output: 0 };
          }
        }
      }

      return {
        apiKey: "",

        async fetch(input, init) {
          // Skip non-Cursor requests
          if (!isCursorApiRequest(input)) {
            return fetch(input, init);
          }

          // Get latest auth state
          let authRecord = await getAuth();
          if (!isOAuthAuth(authRecord)) {
            return fetch(input, init);
          }

          // Refresh token if needed
          if (accessTokenExpired(authRecord)) {
            const refreshed = await refreshCursorAccessToken(authRecord, client);
            if (refreshed) {
              authRecord = refreshed;
            } else {
              // Token refresh failed, try with existing token
              console.warn("[Cursor OAuth] Token refresh failed, using existing token");
            }
          }

          const accessToken = authRecord.access;
          if (!accessToken) {
            return fetch(input, init);
          }

          // Prepare authenticated request
          const { request, init: transformedInit } = prepareCursorRequest(
            input,
            init,
            accessToken
          );

          return fetch(request, transformedInit);
        },
      };
    },

    methods: [
      {
        label: "OAuth with Cursor",
        type: "oauth",
        authorize: async () => {
          console.log("\n=== Cursor OAuth Setup ===");
          console.log("1. You'll be asked to sign in to your Cursor account.");
          console.log("2. After signing in, the authentication will complete automatically.");
          console.log("3. Return to this terminal when you see confirmation.\n");

          const loginManager = new LoginManager();
          const { metadata, loginUrl } = loginManager.startLogin();

          return {
            url: loginUrl,
            instructions:
              "Complete the sign-in flow in your browser. We'll automatically detect when you're done.",
            method: "auto",
            callback: async (): Promise<TokenExchangeResult> => {
              try {
                // Open browser
                try {
                  await openBrowser(loginUrl);
                } catch {
                  console.log("Could not open browser automatically. Please visit the URL above.");
                }

                // Wait for authentication
                const result = await loginManager.waitForResult(metadata, {
                  onProgress: () => process.stdout.write("."),
                });

                if (!result) {
                  return {
                    type: "failed",
                    error: "Authentication timed out or was cancelled",
                  };
                }

                // Get token expiration
                let expires = Date.now() + 3600 * 1000; // 1 hour default
                const payload = decodeJwtPayload(result.accessToken);
                if (payload?.exp && typeof payload.exp === "number") {
                  expires = payload.exp * 1000;
                }

                return {
                  type: "success",
                  refresh: result.refreshToken,
                  access: result.accessToken,
                  expires,
                };
              } catch (error) {
                return {
                  type: "failed",
                  error: error instanceof Error ? error.message : "Unknown error",
                };
              }
            },
          };
        },
      },
      {
        provider: CURSOR_PROVIDER_ID,
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
});

// Alias for compatibility
export const CursorCLIOAuthPlugin = CursorOAuthPlugin;

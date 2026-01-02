/**
 * OpenCode Cursor Auth Plugin
 *
 * An OpenCode plugin that provides OAuth authentication for Cursor's AI backend,
 * following the architecture established by opencode-gemini-auth.
 *
 * This plugin uses a custom fetch function to intercept OpenAI API requests
 * and route them through Cursor's Agent API.
 */

import { exec } from "node:child_process";
import { platform } from "node:os";

import { ModelInfoMap } from "llm-info";
import {
  LoginManager,
  CURSOR_API_BASE_URL,
} from "../lib/auth/login";
import { CursorClient } from "../lib/api/cursor-client";
import { listCursorModels } from "../lib/api/cursor-models";
import { decodeJwtPayload } from "../lib/utils/jwt";
import { refreshAccessToken } from "../lib/auth/helpers";
import { createPluginFetch } from "../lib/openai-compat";
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

const CURSOR_TO_LLM_INFO_MAP: Record<string, string> = {
  "sonnet-4.5": "claude-sonnet-4-5-20250929",
  "sonnet-4.5-thinking": "claude-sonnet-4-5-20250929",
  "opus-4.5": "claude-opus-4-5-20251101",
  "opus-4.5-thinking": "claude-opus-4-5-20251101",
  "opus-4.1": "claude-opus-4-1-20250805",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3-flash": "gemini-2.5-flash",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.1": "gpt-5",
  "gpt-5.1-high": "gpt-5",
  "gpt-5.1-codex": "gpt-5",
  "gpt-5.1-codex-high": "gpt-5",
  "gpt-5.1-codex-max": "gpt-5",
  "gpt-5.1-codex-max-high": "gpt-5",
  "grok": "grok-4",
};

const DEFAULT_LIMITS = { context: 128000, output: 16384 };

function getModelLimits(cursorModelId: string): { context: number; output: number } {
  const llmInfoId = CURSOR_TO_LLM_INFO_MAP[cursorModelId];
  if (!llmInfoId) return DEFAULT_LIMITS;
  
  const info = (ModelInfoMap as Record<string, { contextWindowTokenLimit?: number; outputTokenLimit?: number }>)[llmInfoId];
  if (!info) return DEFAULT_LIMITS;
  
  return {
    context: info.contextWindowTokenLimit ?? DEFAULT_LIMITS.context,
    output: info.outputTokenLimit ?? DEFAULT_LIMITS.output,
  };
}

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
 * - Custom fetch function (no proxy server needed)
 */
export const CursorOAuthPlugin = async ({
  client,
}: PluginContext): Promise<PluginResult> => ({
  auth: {
    provider: CURSOR_PROVIDER_ID,

    loader: async (
      getAuth: GetAuth,
      providerArg: Provider
    ): Promise<LoaderResult | null> => {
      // debugLog("[Cursor Plugin] Loader called");
      // debugLog("[Cursor Plugin] providerArg:", providerArg);
      const auth = await getAuth();

      if (!isOAuthAuth(auth)) {
        // debugLog("[Cursor Plugin] No OAuth auth found, returning null");
        return null;
      }

      // debugLog("[Cursor Plugin] OAuth auth found, checking token expiry");

      // Refresh token if needed
      let authRecord = auth;
      if (accessTokenExpired(authRecord)) {
        // debugLog("[Cursor Plugin] Token expired, refreshing...");
        const refreshed = await refreshCursorAccessToken(authRecord, client);
        if (refreshed) {
          authRecord = refreshed;
          // debugLog("[Cursor Plugin] Token refreshed successfully");
        } else {
          // debugLog("[Cursor Plugin] Token refresh failed");
        }
      }

      const accessToken = authRecord.access;
      if (!accessToken) {
        // debugLog("[Cursor Plugin] No access token available");
        return null;
      }

      // debugLog("[Cursor Plugin] Access token available");

      // Ensure provider and provider.models exist
      const provider = providerArg ?? ({} as Provider);
      provider.models = provider.models ?? {};

      // Set model costs to 0 (Cursor handles billing)
      for (const model of Object.values(provider.models)) {
        if (model) {
          model.cost = { input: 0, output: 0 };
        }
      }

      // Dynamically populate provider models from Cursor API if available.
      try {
        // debugLog("[Cursor Plugin] Fetching models from Cursor API...");
        const cursorClient = new CursorClient(accessToken);
        const models = await listCursorModels(cursorClient);
        // debugLog("[Cursor Plugin] Fetched", models.length, "models from Cursor API");
        if (models.length > 0) {
          for (const m of models) {
            // Determine if this is a "thinking" (reasoning) model
            const isThinking =
              m.modelId?.includes("thinking") ||
              m.displayModelId?.includes("thinking") ||
              m.displayName?.toLowerCase().includes("thinking");

            // Use displayModelId as the primary ID (user-facing), fall back to modelId
            const modelID = m.displayModelId || m.modelId;
            if (!modelID) continue;

            const existingModel = provider.models[modelID];
            const limits = getModelLimits(modelID);
            
            const parsedModel = {
              id: modelID,
              api: {
                id: modelID,
                npm: "@ai-sdk/openai-compatible",
                url: undefined,
              },
              status: "active" as const,
              name: m.displayName || m.displayNameShort || modelID,
              providerID: CURSOR_PROVIDER_ID,
              capabilities: {
                temperature: true,
                reasoning: isThinking,
                attachment: true,
                toolcall: true,
                input: {
                  text: true,
                  audio: false,
                  image: true,
                  video: false,
                  pdf: false,
                },
                output: {
                  text: true,
                  audio: false,
                  image: false,
                  video: false,
                  pdf: false,
                },
                interleaved: false,
              },
              cost: {
                input: 0,
                output: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
              options: {},
              limit: limits,
              headers: {},
              ...existingModel,
            };
            
            provider.models[modelID] = parsedModel;
          }
        }
      } catch (error) {
        // Silently continue with defaults if model listing fails
      }

      // Create custom fetch function instead of starting proxy server
      const customFetch = createPluginFetch({
        accessToken,
        // Disable logging to avoid polluting the UI
        log: () => {},
      });

      // We need to provide baseURL even when using custom fetch
      // OpenCode uses baseURL to identify the provider/API for the model
      // The actual URL doesn't matter since our fetch intercepts everything
      const result = {
        apiKey: "cursor-via-opencode", // Dummy key, not used
        baseURL: "https://cursor.opencode.local/v1", // Virtual URL, intercepted by fetch
        fetch: customFetch,
      };
      // debugLog("[Cursor Plugin] Returning:", { apiKey: result.apiKey, baseURL: result.baseURL, hasFetch: !!result.fetch });
      return result;
    },

    methods: [
      {
        label: "OAuth with Cursor",
        type: "oauth",
        authorize: async (_inputs?: Record<string, string>) => {
          console.log("\n=== Cursor OAuth Setup ===");
          console.log(
            "1. You'll be asked to sign in to your Cursor account."
          );
          console.log(
            "2. After signing in, the authentication will complete automatically."
          );
          console.log(
            "3. Return to this terminal when you see confirmation.\n"
          );

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
                  console.log(
                    "Could not open browser automatically. Please visit the URL above."
                  );
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
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                };
              }
            },
          };
        },
      },
      {
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
});

// Alias for compatibility
export const CursorCLIOAuthPlugin = CursorOAuthPlugin;

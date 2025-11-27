/**
 * OpenCode Cursor Auth Plugin
 *
 * A plugin that provides authentication for Cursor's AI backend,
 * enabling any OpenAI-compatible client to use Cursor's API.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import {
  FileCredentialManager,
  createCredentialManager,
  type CredentialManager,
  type StoredCredentials,
} from "./lib/storage";
import {
  LoginManager,
  CURSOR_API_BASE_URL,
  CURSOR_WEBSITE_URL,
  openBrowser,
  type AuthResult,
  type LoginMetadata,
} from "./lib/auth/login";
import {
  getValidAccessToken,
  authenticateWithApiKey,
  authenticateWithToken,
  isAuthenticated,
  getStoredCredentials,
  clearCredentials,
} from "./lib/auth/helpers";
import {
  decodeJwtPayload,
  isTokenExpiringSoon,
  isTokenExpired,
  getTokenTimeRemaining,
  formatDuration,
  maskToken,
  type JwtPayload,
} from "./lib/utils/jwt";

// --- Plugin Types ---

export interface PluginInput {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  domain?: string;
}

export interface CursorCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AuthInterceptorRequest {
  headers: Map<string, string>;
  url: string;
}

export type NextFn<T = unknown> = (req: AuthInterceptorRequest) => Promise<T>;

// --- Main Plugin Class ---

export class CursorAuthPlugin {
  private credentialManager: FileCredentialManager;
  private loginManager: LoginManager;
  private endpoint: string;
  private domain: string;

  constructor(input: PluginInput = {}) {
    this.domain = input.domain ?? "cursor";
    this.endpoint = input.endpoint ?? CURSOR_API_BASE_URL;
    this.credentialManager = createCredentialManager(this.domain);
    this.loginManager = new LoginManager();
  }

  /**
   * Get the credential manager for direct access
   */
  getCredentialManager(): CredentialManager {
    return this.credentialManager;
  }

  /**
   * Get the storage path for credentials
   */
  getStoragePath(): string {
    return this.credentialManager.getStoragePath();
  }

  /**
   * Check if the user is currently authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    return isAuthenticated(this.credentialManager);
  }

  /**
   * Get all stored credentials
   */
  async getCredentials(): Promise<StoredCredentials> {
    return getStoredCredentials(this.credentialManager);
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getValidAccessToken(): Promise<string | null> {
    return getValidAccessToken(this.credentialManager, this.endpoint);
  }

  /**
   * Start the OAuth login flow
   * Returns the login URL and metadata for polling
   */
  startLogin(): { metadata: LoginMetadata; loginUrl: string } {
    return this.loginManager.startLogin();
  }

  /**
   * Wait for the OAuth login to complete
   */
  async waitForLogin(
    metadata: LoginMetadata,
    options?: { maxAttempts?: number; onProgress?: (attempt: number) => void }
  ): Promise<AuthResult | null> {
    return this.loginManager.waitForResult(metadata, options);
  }

  /**
   * Perform a complete browser-based OAuth login
   */
  async login(options?: {
    maxAttempts?: number;
    onProgress?: (attempt: number) => void;
  }): Promise<boolean> {
    const { metadata, loginUrl } = this.startLogin();

    try {
      await openBrowser(loginUrl);
    } catch {
      // If browser fails to open, user can manually navigate
    }

    const result = await this.waitForLogin(metadata, options);
    if (result) {
      await this.credentialManager.setAuthentication(
        result.accessToken,
        result.refreshToken
      );
      return true;
    }
    return false;
  }

  /**
   * Authenticate using an API key
   */
  async loginWithApiKey(apiKey: string): Promise<boolean> {
    return authenticateWithApiKey(this.credentialManager, apiKey, {
      endpoint: this.endpoint,
    });
  }

  /**
   * Authenticate using a direct token
   */
  async loginWithToken(token: string): Promise<void> {
    return authenticateWithToken(this.credentialManager, token);
  }

  /**
   * Clear all stored credentials (logout)
   */
  async logout(): Promise<void> {
    return clearCredentials(this.credentialManager);
  }

  /**
   * Create an auth interceptor for request middleware
   */
  createAuthInterceptor<T = unknown>() {
    return (next: NextFn<T>) => async (req: AuthInterceptorRequest): Promise<T> => {
      const token = await this.getValidAccessToken();

      if (token !== undefined && token !== null) {
        req.headers.set("authorization", `Bearer ${token}`);
      }

      // Set additional headers
      req.headers.set("x-ghost-mode", "true");
      req.headers.set("x-cursor-client-version", "opencode-cursor-auth");
      req.headers.set("x-cursor-client-type", "cli");

      if (!req.headers.get("x-request-id")) {
        req.headers.set("x-request-id", randomUUID());
      }

      return next(req);
    };
  }

  /**
   * Get token status information
   */
  async getTokenStatus(): Promise<{
    hasToken: boolean;
    hasRefreshToken: boolean;
    hasApiKey: boolean;
    isExpired: boolean;
    isExpiringSoon: boolean;
    timeRemaining: number;
    authId?: string;
  }> {
    const creds = await this.getCredentials();
    const hasToken = !!creds.accessToken;

    if (!hasToken || !creds.accessToken) {
      return {
        hasToken: false,
        hasRefreshToken: !!creds.refreshToken,
        hasApiKey: !!creds.apiKey,
        isExpired: true,
        isExpiringSoon: true,
        timeRemaining: -1,
      };
    }

    const payload = decodeJwtPayload(creds.accessToken);

    return {
      hasToken: true,
      hasRefreshToken: !!creds.refreshToken,
      hasApiKey: !!creds.apiKey,
      isExpired: isTokenExpired(creds.accessToken),
      isExpiringSoon: isTokenExpiringSoon(creds.accessToken),
      timeRemaining: getTokenTimeRemaining(creds.accessToken),
      authId: payload?.sub as string | undefined,
    };
  }
}

// --- Factory Function ---

/**
 * Create a new Cursor Auth Plugin instance
 */
export function createCursorAuthPlugin(input: PluginInput = {}): CursorAuthPlugin {
  return new CursorAuthPlugin(input);
}

// --- Re-exports ---

export {
  // Storage
  FileCredentialManager,
  createCredentialManager,
  type CredentialManager,
  type StoredCredentials,

  // Auth
  LoginManager,
  CURSOR_API_BASE_URL,
  CURSOR_WEBSITE_URL,
  openBrowser,
  getValidAccessToken,
  authenticateWithApiKey,
  authenticateWithToken,
  isAuthenticated,
  getStoredCredentials,
  clearCredentials,
  type AuthResult,
  type LoginMetadata,

  // JWT Utils
  decodeJwtPayload,
  isTokenExpiringSoon,
  isTokenExpired,
  getTokenTimeRemaining,
  formatDuration,
  maskToken,
  type JwtPayload,
};

// --- OpenCode Plugin ---

// Re-export the OpenCode plugin for use with OpenCode
export {
  CursorOAuthPlugin,
  CursorCLIOAuthPlugin,
  CURSOR_PROVIDER_ID,
} from "./plugin";

export type {
  PluginContext,
  PluginResult,
  PluginClient,
  GetAuth,
  Provider,
  LoaderResult,
  AuthDetails,
  OAuthAuthDetails,
  AuthMethod,
  TokenExchangeResult,
} from "./plugin";

// --- Default Export ---

export default createCursorAuthPlugin;

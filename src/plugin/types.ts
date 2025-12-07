/**
 * OpenCode Plugin Types
 *
 * Type definitions for the OpenCode plugin system.
 * These types mirror the @opencode-ai/plugin interface.
 */

// --- Auth Details ---

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface ApiKeyAuthDetails {
  type: "api";
  apiKey: string;
}

export interface TokenAuthDetails {
  type: "token";
  token: string;
}

export type AuthDetails =
  | OAuthAuthDetails
  | ApiKeyAuthDetails
  | TokenAuthDetails
  | { type: string; [key: string]: unknown };

export type GetAuth = () => Promise<AuthDetails>;

// --- Provider ---

export interface ProviderModel {
  cost?: {
    input: number;
    output: number;
  };
  [key: string]: unknown;
}

export interface Provider {
  id?: string;
  name?: string;
  models?: Record<string, ProviderModel | undefined>;
}

// --- Loader ---

/**
 * RequestInfo type for fetch-like functions
 */
export type FetchInput = Request | string | URL;

export interface LoaderResult {
  apiKey?: string;
  baseURL?: string;
  fetch?(input: FetchInput, init?: RequestInit): Promise<Response>;
}

// --- Auth Methods ---

export interface TokenExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
}

export interface TokenExchangeFailure {
  type: "failed";
  error?: string;
}

export type TokenExchangeResult = TokenExchangeSuccess | TokenExchangeFailure;

export interface OAuthAuthMethod {
  label: string;
  type: "oauth";
  authorize: () => Promise<{
    url: string;
    instructions: string;
    method: "auto" | "code";
    callback: (callbackUrl?: string) => Promise<TokenExchangeResult>;
  }>;
}

export interface ApiKeyAuthMethod {
  provider?: string;
  label: string;
  type: "api";
}

export type AuthMethod = OAuthAuthMethod | ApiKeyAuthMethod;

// --- Plugin Client ---

export interface PluginClient {
  auth: {
    set(input: { path: { id: string }; body: AuthDetails }): Promise<void>;
  };
}

// --- Plugin Context ---

export interface PluginContext {
  client: PluginClient;
}

// --- Plugin Result ---

export interface PluginResult {
  auth: {
    provider: string;
    loader: (
      getAuth: GetAuth,
      provider: Provider
    ) => Promise<LoaderResult | null>;
    methods: AuthMethod[];
  };
}

// --- Plugin Function ---

export type Plugin = (context: PluginContext) => Promise<PluginResult>;

// --- Internal Types ---

export interface CursorAuthRecord {
  accessToken: string;
  refreshToken: string;
  expires?: number;
}

/**
 * Auth Module
 *
 * Re-exports all auth-related functionality
 */

// Re-export helpers
export {
  refreshAccessToken,
  getValidAccessToken,
  authenticateWithApiKey,
  authenticateWithToken,
  isAuthenticated,
  getStoredCredentials,
  clearCredentials,
} from "./helpers";

// Re-export login manager and related
export {
  LoginManager,
  CURSOR_API_BASE_URL,
  CURSOR_WEBSITE_URL,
  POLLING_ENDPOINT,
  generateAuthParams,
  openBrowser,
  type AuthResult,
  type AuthParams,
  type LoginMetadata,
} from "./login";

/**
 * Auth Helper Functions
 *
 * Higher-level authentication functions that combine storage and login
 * functionality for common auth operations.
 */

import { isTokenExpiringSoon, isTokenExpired } from "../utils/jwt";
import {
  type CredentialManager,
  type StoredCredentials,
} from "../storage";
import { LoginManager, CURSOR_API_BASE_URL } from "./login";

// --- Token Refresh ---

const REFRESH_ENDPOINT = "/auth/refresh";

/**
 * Refresh an access token using the refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
  endpoint: string = CURSOR_API_BASE_URL
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const response = await fetch(`${endpoint}${REFRESH_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshToken}`,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      return null;
    }

    const result = await response.json();

    if (
      typeof result === "object" &&
      result !== null &&
      "accessToken" in result &&
      "refreshToken" in result
    ) {
      return result as { accessToken: string; refreshToken: string };
    }
  } catch {
    // Refresh failed
  }

  return null;
}

// --- High-Level Auth Functions ---

/**
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(
  credentialManager: CredentialManager,
  endpoint: string = CURSOR_API_BASE_URL
): Promise<string | null> {
  const accessToken = await credentialManager.getAccessToken();

  // Check if we have a valid token
  if (accessToken && !isTokenExpiringSoon(accessToken)) {
    return accessToken;
  }

  // Try to refresh
  const refreshToken = await credentialManager.getRefreshToken();
  if (refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken, endpoint);
    if (refreshed) {
      await credentialManager.setAuthentication(
        refreshed.accessToken,
        refreshed.refreshToken
      );
      return refreshed.accessToken;
    }
  }

  // Return possibly expired token (let the API reject if needed)
  return accessToken ?? null;
}

/**
 * Authenticate using an API key
 */
export async function authenticateWithApiKey(
  credentialManager: CredentialManager,
  apiKey: string,
  options?: { endpoint?: string }
): Promise<boolean> {
  const loginManager = new LoginManager();
  const result = await loginManager.loginWithApiKey(apiKey, options);

  if (result) {
    await credentialManager.setAuthentication(
      result.accessToken,
      result.refreshToken,
      apiKey
    );
    return true;
  }

  return false;
}

/**
 * Authenticate using a direct token (no refresh token)
 */
export async function authenticateWithToken(
  credentialManager: CredentialManager,
  token: string
): Promise<void> {
  // Store token without refresh token
  await credentialManager.setAuthentication(token, "");
}

/**
 * Check if the user is authenticated with a valid token
 */
export async function isAuthenticated(
  credentialManager: CredentialManager
): Promise<boolean> {
  const token = await credentialManager.getAccessToken();
  if (!token) return false;
  return !isTokenExpired(token);
}

/**
 * Get stored credentials
 */
export async function getStoredCredentials(
  credentialManager: CredentialManager
): Promise<StoredCredentials> {
  return credentialManager.getAllCredentials();
}

/**
 * Clear all credentials
 */
export async function clearCredentials(
  credentialManager: CredentialManager
): Promise<void> {
  return credentialManager.clearAuthentication();
}

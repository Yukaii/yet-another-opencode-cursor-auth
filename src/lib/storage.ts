/**
 * Credential Storage
 *
 * File-based credential storage for cross-platform compatibility.
 * Stores authentication tokens in a JSON file.
 */

import { platform, homedir } from "node:os";
import { join, dirname } from "node:path";
import { promises as fs } from "node:fs";

export interface StoredCredentials {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
}

export interface CredentialManager {
  getAccessToken(): Promise<string | undefined>;
  getRefreshToken(): Promise<string | undefined>;
  getApiKey(): Promise<string | undefined>;
  getAllCredentials(): Promise<StoredCredentials>;
  setAuthentication(
    accessToken: string,
    refreshToken: string,
    apiKey?: string
  ): Promise<void>;
  clearAuthentication(): Promise<void>;
  getStoragePath(): string;
}

/**
 * FileCredentialManager - File-based credential storage
 *
 * Storage Locations:
 * - Windows: %APPDATA%\<TitleCase(domain)>\auth.json
 * - macOS: ~/.<domain>/auth.json
 * - Linux: $XDG_CONFIG_HOME/<domain>/auth.json or ~/.config/<domain>/auth.json
 */
export class FileCredentialManager implements CredentialManager {
  private cachedAccessToken: string | null = null;
  private cachedRefreshToken: string | null = null;
  private cachedApiKey: string | null = null;
  private authFilePath: string;

  constructor(domain: string = "cursor") {
    this.authFilePath = this.getAuthFilePath(domain);
  }

  private toWindowsTitleCase(domain: string): string {
    if (domain.length === 0) return domain;
    return domain.charAt(0).toUpperCase() + domain.slice(1).toLowerCase();
  }

  private getAuthFilePath(domain: string): string {
    const currentPlatform = platform();

    switch (currentPlatform) {
      case "win32": {
        const appData =
          process.env.APPDATA || join(homedir(), "AppData", "Roaming");
        const folder = this.toWindowsTitleCase(domain);
        return join(appData, folder, "auth.json");
      }
      case "darwin":
        return join(homedir(), `.${domain}`, "auth.json");
      default: {
        const configDir =
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
        return join(configDir, domain, "auth.json");
      }
    }
  }

  getStoragePath(): string {
    return this.authFilePath;
  }

  private async ensureDirectoryExists(): Promise<void> {
    const dir = dirname(this.authFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async readAuthData(): Promise<StoredCredentials | null> {
    try {
      const data = await fs.readFile(this.authFilePath, "utf-8");
      return JSON.parse(data);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  private async writeAuthData(data: StoredCredentials): Promise<void> {
    await this.ensureDirectoryExists();
    await fs.writeFile(
      this.authFilePath,
      JSON.stringify(data, null, 2),
      "utf-8"
    );
  }

  async setAuthentication(
    accessToken: string,
    refreshToken: string,
    apiKey?: string
  ): Promise<void> {
    await this.writeAuthData({ accessToken, refreshToken, apiKey });
    this.cachedAccessToken = accessToken;
    this.cachedRefreshToken = refreshToken;
    this.cachedApiKey = apiKey ?? null;
  }

  async getAccessToken(): Promise<string | undefined> {
    if (this.cachedAccessToken) return this.cachedAccessToken;
    const authData = await this.readAuthData();
    if (authData?.accessToken) {
      this.cachedAccessToken = authData.accessToken;
      this.cachedRefreshToken = authData.refreshToken ?? null;
      this.cachedApiKey = authData.apiKey ?? null;
      return authData.accessToken;
    }
    return undefined;
  }

  async getRefreshToken(): Promise<string | undefined> {
    if (this.cachedRefreshToken) return this.cachedRefreshToken;
    const authData = await this.readAuthData();
    if (authData?.refreshToken) {
      this.cachedAccessToken = authData.accessToken ?? null;
      this.cachedRefreshToken = authData.refreshToken;
      this.cachedApiKey = authData.apiKey ?? null;
      return authData.refreshToken;
    }
    return undefined;
  }

  async getApiKey(): Promise<string | undefined> {
    if (this.cachedApiKey) return this.cachedApiKey;
    const authData = await this.readAuthData();
    if (authData?.apiKey) {
      this.cachedApiKey = authData.apiKey;
      return authData.apiKey;
    }
    return undefined;
  }

  async getAllCredentials(): Promise<StoredCredentials> {
    if (this.cachedAccessToken !== null && this.cachedRefreshToken !== null) {
      return {
        accessToken: this.cachedAccessToken || undefined,
        refreshToken: this.cachedRefreshToken || undefined,
        apiKey: this.cachedApiKey || undefined,
      };
    }
    const authData = await this.readAuthData();
    if (authData) {
      this.cachedAccessToken = authData.accessToken || null;
      this.cachedRefreshToken = authData.refreshToken || null;
      this.cachedApiKey = authData.apiKey || null;
      return authData;
    }
    return {};
  }

  async clearAuthentication(): Promise<void> {
    try {
      await fs.unlink(this.authFilePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.cachedAccessToken = null;
    this.cachedRefreshToken = null;
    this.cachedApiKey = null;
  }

  /**
   * Clear cached values to force reload from disk
   */
  clearCache(): void {
    this.cachedAccessToken = null;
    this.cachedRefreshToken = null;
    this.cachedApiKey = null;
  }
}

/**
 * Create a credential manager for the specified domain
 */
export function createCredentialManager(
  domain: string = "cursor"
): FileCredentialManager {
  return new FileCredentialManager(domain);
}

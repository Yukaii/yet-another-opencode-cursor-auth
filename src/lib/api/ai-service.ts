import { CursorClient } from "./cursor-client";

const SERVICE_BASE = "aiserver.v1.AiService";

type UsableModel = {
  modelId?: string;
  displayModelId?: string;
  displayName?: string;
  displayNameShort?: string;
  aliases?: string[];
};

export interface GetUsableModelsResponse {
  models?: UsableModel[];
}

export interface GetDefaultModelForCliResponse {
  model?: UsableModel;
}

/**
 * Minimal Cursor AiService client using Connect JSON over fetch.
 * This is intentionally lightweight and only covers the methods we need.
 */
export class AiServiceClient {
  constructor(private cursor: CursorClient) {}

  private async postJson<TRequest, TResponse>(
    method: string,
    body: TRequest
  ): Promise<TResponse> {
    const baseUrl = this.cursor.getBaseUrl();
    const headers = this.cursor.buildHeaders({
      "content-type": "application/json",
      accept: "application/json",
      "connect-protocol-version": "1",
    });

    const response = await fetch(`${baseUrl}/${SERVICE_BASE}/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    });

    if (!response.ok) {
      throw new Error(`AiService ${method} failed with ${response.status}`);
    }

    return (await response.json()) as TResponse;
  }

  async getUsableModels(): Promise<UsableModel[]> {
    const data = await this.postJson<Record<string, never>, GetUsableModelsResponse>(
      "GetUsableModels",
      {}
    );
    return Array.isArray(data.models) ? data.models : [];
  }

  async getDefaultModelForCli(): Promise<UsableModel | undefined> {
    const data = await this.postJson<Record<string, never>, GetDefaultModelForCliResponse>(
      "GetDefaultModelForCli",
      {}
    );
    return data.model;
  }
}

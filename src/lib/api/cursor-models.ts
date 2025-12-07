import { CursorClient } from "./cursor-client";
import { AiServiceClient } from "./ai-service";

export interface CursorModelInfo {
  modelId: string;
  displayModelId?: string;
  aliases: string[];
  displayName?: string;
  displayNameShort?: string;
}

/**
 * List available Cursor models using the GetUsableModels RPC over Connect JSON.
 * Falls back to an empty list on errors.
 */
export async function listCursorModels(cursorClient: CursorClient): Promise<CursorModelInfo[]> {
  try {
    const aiService = new AiServiceClient(cursorClient);
    const models = await aiService.getUsableModels();
    const result: CursorModelInfo[] = [];

    for (const m of models) {
      const modelId = typeof m?.modelId === "string" ? m.modelId : undefined;
      const displayModelId =
        typeof m?.displayModelId === "string" ? m.displayModelId : undefined;
      if (!modelId && !displayModelId) {
        continue;
      }
      result.push({
        modelId: modelId ?? displayModelId ?? "",
        displayModelId,
        aliases: Array.isArray(m?.aliases)
          ? (m?.aliases as unknown[]).filter((a): a is string => typeof a === "string")
          : [],
        displayName: typeof m?.displayName === "string" ? m.displayName : undefined,
        displayNameShort:
          typeof m?.displayNameShort === "string" ? m.displayNameShort : undefined,
      });
    }

    return result;
  } catch {
    return [];
  }
}

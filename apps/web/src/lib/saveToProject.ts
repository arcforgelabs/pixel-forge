import { HTTP_BACKEND_URL } from "../config";
import { Stack } from "./stacks";

export interface SaveResult {
  success: boolean;
  filePath: string;
  relPath: string;
  urlPath: string;
  message: string;
}

export async function saveToProject(
  code: string,
  projectPath: string,
  stack: Stack,
  filePath?: string | null
): Promise<SaveResult> {
  try {
    const response = await fetch(`${HTTP_BACKEND_URL}/save-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        project_path: projectPath,
        file_path: filePath || undefined,
        stack,
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        filePath: "",
        relPath: "",
        urlPath: "",
        message: `HTTP error: ${response.status}`,
      };
    }

    const result = await response.json();
    return {
      success: result.success,
      filePath: result.file_path || "",
      relPath: result.rel_path || "",
      urlPath: result.url_path || "",
      message: result.message || "",
    };
  } catch (error) {
    return {
      success: false,
      filePath: "",
      relPath: "",
      urlPath: "",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

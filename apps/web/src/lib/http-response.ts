export async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function getResponseErrorMessage(
  response: Pick<Response, "status">,
  payload: unknown
): string {
  const fallback = `HTTP ${response.status}`;

  if (
    payload &&
    typeof payload === "object" &&
    "detail" in payload &&
    typeof (payload as { detail?: unknown }).detail === "string" &&
    (payload as { detail: string }).detail.trim()
  ) {
    return (payload as { detail: string }).detail;
  }

  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }

  return fallback;
}

export async function embedTexts(
  texts: string[],
  model: string,
): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in Convex environment variables");
  }
  if (texts.length === 0) {
    return [];
  }

  const maxAttempts = 5;
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(`Embedding request failed: ${String(err)}`);
      lastError = error;

      if (attempt >= maxAttempts) {
        throw error;
      }

      const backoffMs = Math.min(500 * 2 ** (attempt - 1), 8000);
      const jitter = Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, backoffMs + jitter));
      continue;
    }

    if (response.ok) {
      const json = await response.json();
      return json.data.map((item: { embedding: number[] }) => item.embedding);
    }

    const body = await response.text();
    const retryable = [429, 500, 502, 503, 504].includes(response.status);
    const error = new Error(
      `Embedding request failed (${response.status}): ${body}`,
    );
    lastError = error;

    if (!retryable || attempt >= maxAttempts) {
      throw error;
    }

    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 8000);
    const jitter = Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, backoffMs + jitter));
  }

  throw lastError ?? new Error("Embedding request failed");
}

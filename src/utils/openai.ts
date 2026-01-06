import OpenAI from "openai";

// Lazy initialization to allow dotenv override to run first
let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY");
    }
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

/**
 * Generate embedding for text using OpenAI's text-embedding-3-small model
 * Returns a 1536-dimensional vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // Truncate to ~8000 tokens (roughly 32000 chars) to stay within limits
  const truncatedText = text.slice(0, 32000);

  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: truncatedText,
  });

  return response.data[0].embedding;
}

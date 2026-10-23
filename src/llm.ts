export interface Llm {
  name: string;
  complete(system: string, user: string): Promise<string>;
}

interface ClaudeResponse {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

export function claude(apiKey: string, model = 'claude-sonnet-5-5'): Llm {
  return {
    name: `claude:${model}`,
    async complete(system, user) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 700, temperature: 0.2, system, messages: [{ role: 'user', content: user }] }),
      });
      const data = (await res.json()) as ClaudeResponse;
      const text = data.content?.find((c) => c.type === 'text')?.text;
      if (!res.ok || text === undefined) throw new Error(`Claude request failed (${res.status}): ${data.error?.message ?? 'empty reply'}`);
      return text.trim();
    },
  };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string };
}

export function gemini(apiKey: string, model = 'gemini-3.8-flash'): Llm {
  return {
    name: `gemini:${model}`,
    async complete(system, user) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
        }),
      });
      const data = (await res.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      if (!res.ok || !text) throw new Error(`Gemini request failed (${res.status}): ${data.error?.message ?? 'empty reply'}`);
      return text.trim();
    },
  };
}

/** Claude if a key is set, else Gemini, else null (the app then returns the passages themselves). */
export function pickLlm(env: NodeJS.ProcessEnv = process.env): Llm | null {
  if (env.ANTHROPIC_API_KEY) return claude(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL || undefined);
  if (env.GEMINI_API_KEY) return gemini(env.GEMINI_API_KEY, env.GEMINI_MODEL || undefined);
  return null;
}

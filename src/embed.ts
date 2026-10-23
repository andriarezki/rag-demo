export type EmbedTask = 'document' | 'query';

export interface Embedder {
  /** Stored with the index so a query is never compared against vectors from another model. */
  name: string;
  /** Cosine score below which a passage is treated as "not about this question". */
  defaultMinScore: number;
  embed(texts: string[], task: EmbedTask): Promise<number[][]>;
}

const STOPWORDS = new Set(
  (
    'yang dan di ke dari untuk dengan atau ini itu pada adalah akan dapat bisa juga ada tidak ' +
    'saya kami kita anda apa siapa bagaimana berapa kapan mana apakah ' +
    'the a an of to in on for and or is are was be by with at as it this that from what how when who which do does can'
  ).split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** FNV-1a, 32 bit. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Offline fallback: feature hashing of words and word pairs into a fixed-size
 * vector. It matches on shared words, not on meaning, so "laptop hilang" will not
 * find "kehilangan perangkat". Good enough to run the whole pipeline with no
 * API key and to keep the tests deterministic.
 */
export function hashEmbedder(dim = 1024): Embedder {
  return {
    name: `hash-${dim}`,
    defaultMinScore: 0.12,
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(dim).fill(0);
        const tokens = tokenize(text);
        const features = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
        const counts = new Map<string, number>();
        for (const f of features) counts.set(f, (counts.get(f) ?? 0) + 1);
        for (const [f, c] of counts) {
          const h = fnv(f);
          v[h % dim]! += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(c));
        }
        return normalize(v);
      });
    },
  };
}

interface GeminiEmbedResponse {
  embeddings?: { values: number[] }[];
  error?: { message?: string };
}

/** Gemini embeddings through the REST API (no SDK). */
export function geminiEmbedder(apiKey: string, model = 'gemini-embedding-001'): Embedder {
  return {
    name: `gemini:${model}`,
    defaultMinScore: 0.55,
    async embed(texts, task) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 50) {
        const batch = texts.slice(i, i + 50);
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              requests: batch.map((text) => ({
                model: `models/${model}`,
                content: { parts: [{ text }] },
                taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              })),
            }),
          },
        );
        const data = (await res.json()) as GeminiEmbedResponse;
        if (!res.ok || !data.embeddings) {
          throw new Error(`Gemini embeddings failed (${res.status}): ${data.error?.message ?? 'no embeddings returned'}`);
        }
        out.push(...data.embeddings.map((e) => normalize(e.values)));
      }
      return out;
    },
  };
}

export function pickEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  if (env.GEMINI_API_KEY) return geminiEmbedder(env.GEMINI_API_KEY, env.GEMINI_EMBED_MODEL || undefined);
  return hashEmbedder();
}

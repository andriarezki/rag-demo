import { VectorStore } from './store.js';
import { pickEmbedder, type Embedder } from './embed.js';
import { pickLlm, type Llm } from './llm.js';
import type { SearchMode } from './rag.js';

export interface Runtime {
  store: VectorStore;
  embedder: Embedder;
  llm: Llm | null;
  docsDir: string;
  topK: number;
  minScore: number | undefined;
  mode: SearchMode;
  auth: { user: string; password: string } | undefined;
  logFile: string | undefined;
}

export function runtime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const embedder = pickEmbedder(env);
  return {
    store: new VectorStore(env.DB_FILE ?? 'data/rag.db'),
    embedder,
    llm: pickLlm(env),
    docsDir: env.DOCS_DIR ?? 'docs/sample',
    topK: Number(env.TOP_K) || 4,
    minScore: env.MIN_SCORE ? Number(env.MIN_SCORE) : undefined,
    auth: env.APP_USER && env.APP_PASSWORD ? { user: env.APP_USER, password: env.APP_PASSWORD } : undefined,
    logFile: env.LOG_QUESTIONS || undefined,
    mode: (['hybrid', 'vector', 'keyword'] as const).find((m) => m === env.SEARCH_MODE) ?? 'hybrid',
  };
}

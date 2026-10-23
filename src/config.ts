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
  /** Name and one-line description shown on the web page (branding for a deployment). */
  appName: string;
  appSubtitle: string;
  /** Example questions shown as buttons under the search box. */
  examples: string[];
}

const DEMO_EXAMPLES = ['Berapa lama saya harus melapor kalau laptop dicuri?', 'Batas waktu mengajukan reimbursement berapa hari?', 'Bagaimana resep nasi goreng yang enak?'];

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
    examples: env.APP_EXAMPLES === undefined ? DEMO_EXAMPLES : env.APP_EXAMPLES.split('|').map((x) => x.trim()).filter(Boolean),
    appName: env.APP_NAME || 'Tanya dokumen',
    appSubtitle: env.APP_SUBTITLE || 'Jawaban diambil dari dokumen contoh (handbook perusahaan fiktif), lengkap dengan sumbernya.',
    mode: (['hybrid', 'vector', 'keyword'] as const).find((m) => m === env.SEARCH_MODE) ?? 'hybrid',
  };
}

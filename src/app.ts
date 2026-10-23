import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Embedder } from './embed.js';
import type { Llm } from './llm.js';
import { ask, type SearchMode } from './rag.js';
import type { VectorStore } from './store.js';

const body = z.object({ question: z.string().trim().min(3).max(300) });

export interface AppDeps {
  store: VectorStore;
  embedder: Embedder;
  llm: Llm | null;
  topK?: number;
  minScore?: number | undefined;
  mode?: SearchMode;
  name?: string;
  subtitle?: string;
  examples?: string[];
  /** Optional HTTP Basic login for the whole site, for a pilot on a shared network. */
  auth?: { user: string; password: string };
  /** Optional JSON-lines file where every question is recorded (time, IP, question, result, sources). */
  logFile?: string;
  /** Requests per minute per IP on /api/ask. A public demo calls a paid API, so it is capped. */
  rateLimit?: number;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  if (deps.auth) {
    const digest = (v: string) => createHash('sha256').update(v).digest();
    const expected = digest(`${deps.auth.user}:${deps.auth.password}`);
    app.use((req, res, next) => {
      const header = req.headers.authorization ?? '';
      const given = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
      if (timingSafeEqual(digest(given), expected)) return next();
      res.set('WWW-Authenticate', 'Basic realm="Asisten dokumen"').status(401).send('Login diperlukan.');
    });
  }

  app.use(express.json({ limit: '4kb' }));

  const hits = new Map<string, { n: number; reset: number }>();
  const limit = deps.rateLimit ?? 20;
  const limiter: express.RequestHandler = (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const cur = hits.get(key);
    if (!cur || cur.reset < now) hits.set(key, { n: 1, reset: now + 60_000 });
    else if (++cur.n > limit) {
      res.status(429).json({ error: 'Too many questions. Try again in a minute.' });
      return;
    }
    next();
  };

  app.get('/api/info', (_req, res) => {
    res.json({
      documents: deps.store.docCount(),
      chunks: deps.store.count(),
      embedder: deps.embedder.name,
      answerModel: deps.llm?.name ?? null,
      search: deps.mode ?? 'hybrid',
      name: deps.name ?? 'Tanya dokumen',
      subtitle: deps.subtitle ?? '',
      examples: deps.examples ?? [],
    });
  });

  app.post('/api/ask', limiter, async (req, res) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Send {"question": "..."} with 3 to 300 characters.' });
      return;
    }
    try {
      const answer = await ask(parsed.data.question, deps.store, deps.embedder, deps.llm, { k: deps.topK ?? 4, minScore: deps.minScore, mode: deps.mode });
      if (deps.logFile) {
        const line = JSON.stringify({ t: new Date().toISOString(), ip: req.ip, q: parsed.data.question, mode: answer.mode, sources: answer.sources.map((x) => ({ doc: x.doc, page: x.page, score: x.score })) });
        await mkdir(dirname(deps.logFile), { recursive: true });
        await appendFile(deps.logFile, `${line}\n`).catch((e) => console.error('question log failed:', e));
      }
      res.json(answer);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Could not answer right now.' });
    }
  });

  app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), '..', 'public')));
  return app;
}

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { runtime } from './config.js';
import { ingest } from './rag.js';

mkdirSync(dirname(process.env.DB_FILE ?? 'data/rag.db'), { recursive: true });
const rt = runtime();

// Build the index on first start (or when the embedder changed), so `docker compose up` just works.
if (rt.store.count() === 0 || rt.store.embedderName !== rt.embedder.name) {
  const r = await ingest(rt.docsDir, rt.store, rt.embedder);
  console.log(`Indexed ${r.chunks} chunks from ${r.docs} documents (embedder: ${rt.embedder.name})`);
}

const port = Number(process.env.PORT) || 3000;
createApp({ store: rt.store, embedder: rt.embedder, llm: rt.llm, topK: rt.topK, minScore: rt.minScore }).listen(port, () => {
  console.log(`RAG demo on http://localhost:${port} | embedder: ${rt.embedder.name} | answers: ${rt.llm?.name ?? 'passages only (no API key)'}`);
});

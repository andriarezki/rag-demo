import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { runtime } from './config.js';
import { ingest } from './rag.js';

mkdirSync(dirname(process.env.DB_FILE ?? 'data/rag.db'), { recursive: true });
const rt = runtime();

if (rt.auth?.password === 'GANTI-DENGAN-PASSWORD-ANDA') {
  console.error('APP_PASSWORD di config.env masih contoh. Ganti dulu, lalu jalankan ulang. / APP_PASSWORD is still the placeholder; change it and start again.');
  process.exit(1);
}

// Build the index on first start (or when the embedder changed), so `docker compose up` just works.
if (rt.store.count() === 0 || rt.store.embedderName !== rt.embedder.name) {
  const r = await ingest(rt.docsDir, rt.store, rt.embedder);
  console.log(`Indexed ${r.chunks} chunks from ${r.docs} documents (embedder: ${rt.embedder.name})`);
  if (r.empty.length) console.log(`No text found in ${r.empty.length} file(s), skipped (scanned PDFs need OCR): ${r.empty.slice(0, 5).join(', ')}`);
  if (r.failed.length) console.log(`Could not read ${r.failed.length} file(s): ${r.failed.slice(0, 5).map((f) => f.file).join(', ')}`);
}

const port = Number(process.env.PORT) || 3000;
createApp({ store: rt.store, embedder: rt.embedder, llm: rt.llm, topK: rt.topK, minScore: rt.minScore, mode: rt.mode, auth: rt.auth, logFile: rt.logFile, name: rt.appName, subtitle: rt.appSubtitle, examples: rt.examples }).listen(port, () => {
  console.log(`${rt.appName} on http://localhost:${port} | embedder: ${rt.embedder.name} | search: ${rt.mode} | answers: ${rt.llm?.name ?? 'passages only (no API key)'}${rt.auth ? ' | login required' : ''}`);
});

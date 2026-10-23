import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtime } from './config.js';
import { ask, ingest, relevance, retrieve, type SearchMode } from './rag.js';

interface EvalCase {
  q: string;
  /** Document that contains the answer, or null when the question is NOT covered by the documents. */
  doc: string | null;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const env = process.env;
  mkdirSync(dirname(env.DB_FILE ?? 'data/rag.db'), { recursive: true });
  const rt = runtime();
  const minScore = rt.minScore ?? rt.embedder.defaultMinScore;

  if (cmd === 'ingest') {
    const dir = rest[0] ?? rt.docsDir;
    const r = await ingest(dir, rt.store, rt.embedder);
    console.log(`Indexed ${r.chunks} chunks from ${r.docs} documents in ${dir} (embedder: ${rt.embedder.name})`);
    for (const f of r.empty) console.log(`  no text, skipped (scanned PDF? needs OCR): ${f}`);
    for (const f of r.failed) console.log(`  could not read: ${f.file} (${f.error})`);
  } else if (cmd === 'ask') {
    const question = rest.join(' ').trim();
    if (!question) throw new Error('Usage: npm run ask -- "your question"');
    const a = await ask(question, rt.store, rt.embedder, rt.llm, { k: rt.topK, minScore: rt.minScore, mode: rt.mode });
    console.log(`\n${a.answer}\n`);
    for (const s of a.sources) console.log(`  [${s.n}] ${s.doc}${s.page ? ` p.${s.page}` : ` > ${s.heading}`}  (score ${s.score}, found by ${s.via})`);
    console.log(`\nmode: ${a.mode} | search: ${rt.mode} | embedder: ${rt.embedder.name} | answer model: ${rt.llm?.name ?? 'none'}`);
  } else if (cmd === 'eval') {
    const cases = JSON.parse(readFileSync(rest[0] ?? 'eval/questions.json', 'utf8')) as EvalCase[];
    const answerable = cases.filter((c) => c.doc !== null);
    const offTopic = cases.filter((c) => c.doc === null);
    console.log(`embedder: ${rt.embedder.name} | min score: ${minScore} | ${answerable.length} answerable + ${offTopic.length} off-topic questions\n`);
    console.log('search    hit@1   hit@3   off-topic refused');
    for (const mode of ['vector', 'keyword', 'hybrid'] as SearchMode[]) {
      let hit1 = 0, hit3 = 0, refused = 0;
      const notes: string[] = [];
      for (const c of answerable) {
        const hits = await retrieve(c.q, rt.store, rt.embedder, 3, mode);
        if (hits[0]?.doc === c.doc) hit1++;
        if (hits.some((h) => h.doc === c.doc)) hit3++;
        else notes.push(`expected ${c.doc}, got ${hits.map((h) => h.doc).join(', ') || 'nothing'}: ${c.q}`);
      }
      for (const c of offTopic) {
        const hits = await retrieve(c.q, rt.store, rt.embedder, 4, mode);
        if (hits.every((h) => relevance(h, mode, minScore) === null)) refused++;
        else notes.push(`should refuse but a passage passed the guard: ${c.q}`);
      }
      console.log(`${mode.padEnd(9)} ${`${hit1}/${answerable.length}`.padEnd(7)} ${`${hit3}/${answerable.length}`.padEnd(7)} ${refused}/${offTopic.length}`);
      for (const n of notes) console.log(`          miss: ${n}`);
    }
  } else {
    console.log('Usage: npm run ingest [dir] | npm run ask -- "question" | npm run eval [file]');
    process.exitCode = 1;
  }
  rt.store.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtime } from './config.js';
import { ask, ingest, retrieve } from './rag.js';

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
  } else if (cmd === 'ask') {
    const question = rest.join(' ').trim();
    if (!question) throw new Error('Usage: npm run ask -- "your question"');
    const a = await ask(question, rt.store, rt.embedder, rt.llm, { k: rt.topK, minScore: rt.minScore });
    console.log(`\n${a.answer}\n`);
    for (const s of a.sources) console.log(`  [${s.n}] ${s.doc} > ${s.heading}  (score ${s.score})`);
    console.log(`\nmode: ${a.mode} | embedder: ${rt.embedder.name} | answer model: ${rt.llm?.name ?? 'none'}`);
  } else if (cmd === 'eval') {
    const cases = JSON.parse(readFileSync(rest[0] ?? 'eval/questions.json', 'utf8')) as EvalCase[];
    let answerable = 0, hit1 = 0, hit3 = 0, offTopic = 0, refused = 0;
    const misses: string[] = [];
    for (const c of cases) {
      const hits = await retrieve(c.q, rt.store, rt.embedder, 3);
      if (c.doc === null) {
        offTopic++;
        if ((hits[0]?.score ?? 0) < minScore) refused++;
        else misses.push(`should refuse but scored ${hits[0]!.score.toFixed(2)}: ${c.q}`);
      } else {
        answerable++;
        if (hits[0]?.doc === c.doc) hit1++;
        if (hits.some((h) => h.doc === c.doc)) hit3++;
        else misses.push(`expected ${c.doc}, got ${hits.map((h) => h.doc).join(', ')}: ${c.q}`);
      }
    }
    console.log(`embedder: ${rt.embedder.name} | min score: ${minScore}`);
    console.log(`answerable questions: ${answerable}  hit@1 ${hit1}/${answerable}  hit@3 ${hit3}/${answerable}`);
    console.log(`off-topic questions:  ${offTopic}  correctly refused ${refused}/${offTopic}`);
    for (const m of misses) console.log(`  miss: ${m}`);
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

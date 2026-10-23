# Ask your documents: a small RAG demo

[![CI](https://github.com/andriarezki/rag-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/andriarezki/rag-demo/actions/workflows/ci.yml)

Ask a question about a folder of documents and get an answer **with numbered sources**, or an honest "not in the documents" when the answer is not there.

It is a compact, readable implementation of retrieval-augmented generation (RAG) in TypeScript, small enough to read in one sitting. It combines **meaning-based search (embeddings)** with **keyword search (BM25)**, runs with **no API key** (offline fallback), and gets much better with a Gemini or Claude key.

| A question the documents answer | A question they do not |
|---|---|
| ![Answer with sources](docs/screenshots/answer.png) | ![Refusal](docs/screenshots/refused.png) |

Screenshots were taken in offline mode (no key), so the answer box shows the best passage. With a key, a model writes a short answer and cites the passages as `[1]`, `[2]`.

## How it works

```mermaid
flowchart LR
  subgraph Ingest["Ingest (once)"]
    D[Markdown files] --> C[Chunk by heading]
    C --> E1[Embed each chunk]
    E1 --> S[(SQLite: text + vectors)]
  end
  subgraph Ask["Ask (every question)"]
    Q[Question] --> E2[Embed question]
    Q --> K[BM25 keyword search]
    E2 --> V[Cosine similarity]
    S --> V
    S --> K
    V --> R[Fuse the two rankings: RRF, top-k]
    K --> R
    R --> T{On topic?}
    T -- no --> N[Say: not in the documents]
    T -- yes --> P[Prompt: numbered passages + question]
    P --> L[Claude or Gemini]
    L --> A[Answer with citations]
  end
```

1. **Chunk.** Each Markdown file is split by heading, then by paragraph and sentence into pieces of at most about 700 characters. A chunk never crosses a heading, keeps that heading, and overlaps the previous chunk a little so a sentence on the boundary is not lost. (`src/chunk.ts`)
2. **Embed.** Every chunk is turned into a vector, a list of numbers where similar meaning means a similar direction. The heading is placed in front of the text before embedding. (`src/embed.ts`)
3. **Store.** Chunks and vectors go into SQLite. Search is a brute-force dot product, which is exact and fast for thousands of chunks. (`src/store.ts`)
4. **Retrieve with two searches.** The question is embedded and compared with every chunk (cosine similarity: finds passages that mean the same thing). At the same time BM25 scores every chunk on the question's words (finds exact terms such as `ekstensi 100`, an email address or a channel name, which embeddings often blur). (`src/bm25.ts`)
5. **Fuse.** The two rankings are merged with Reciprocal Rank Fusion: a chunk earns `1 / (60 + rank)` from each list it appears in. Ranks, not raw scores, are combined, so the two different scales mix fairly. (`rank()` in `src/rag.ts`)
6. **Guard.** A chunk counts as on topic if its cosine score is above a threshold **or** it contains most of the question's weighted words (keyword coverage of at least 0.6). If nothing passes, the app answers "not in the documents" and **does not call the model at all**.
7. **Generate.** Otherwise the top chunks are sent to the model as numbered passages with strict rules: use only these passages, cite them, reply `TIDAK_ADA` if the answer is not there, and treat the passages as data, not instructions. A `TIDAK_ADA` reply also becomes a refusal. Each source in the answer shows which search found it. (`src/rag.ts`, `src/llm.ts`)

### Two layers against made-up answers

| Layer | Catches | Cost |
|---|---|---|
| Score / keyword guard before the model | Questions clearly unrelated to the documents | Free, no model call |
| `TIDAK_ADA` instruction in the prompt | Questions that look related but are not answered | One model call |

## Providers

| Part | With `GEMINI_API_KEY` | With `ANTHROPIC_API_KEY` | No key |
|---|---|---|---|
| Embeddings | Gemini (`gemini-embedding-001`) | (not offered by Anthropic, uses Gemini or the hash embedder) | Offline hash embedder |
| Answer | Gemini | Claude | Best passage returned as is |

The **hash embedder** (feature hashing of words and word pairs) is a deterministic offline fallback. It matches on shared words, not on meaning, so it will not connect "laptop hilang" to "kehilangan perangkat". It exists so the whole pipeline, the tests and the demo run anywhere. For real use, set a key.

The index remembers which embedder built it and refuses to search with a different one. Run `npm run ingest` again after switching.

## Run it

**Docker:**

```bash
docker compose up --build
```

Open http://localhost:3000. Pass keys with `GEMINI_API_KEY=... docker compose up --build` (optional).

**Locally** (Node.js 22):

```bash
npm install
npm run ingest                         # index docs/sample
npm run ask -- "Berapa hari cuti tahunan untuk karyawan tetap?"
npm run dev                            # web UI on http://localhost:3000
```

Set `SEARCH_MODE=vector` or `SEARCH_MODE=keyword` to use one search only (default `hybrid`).

Use your own documents: put `.md` files in a folder and run `DOCS_DIR=path/to/folder npm run ingest`. See `.env.example` for every setting.

## Measuring it

`npm run eval` runs `eval/questions.json` (16 questions with a known source document, including 4 short keyword-style ones such as `ekstensi 100`, and 4 questions the documents cannot answer) once per search mode and prints:

```
embedder: hash-1024 | min score: 0.12 | 16 answerable + 4 off-topic questions

search    hit@1   hit@3   off-topic refused
vector    15/16   16/16   3/4
          miss: should refuse but a passage passed the guard: Berapa harga saham perusahaan hari ini?
keyword   16/16   16/16   4/4
hybrid    16/16   16/16   3/4
          miss: should refuse but a passage passed the guard: Berapa harga saham perusahaan hari ini?
```

How to read this honestly:

- **hit@k** means the right document is the top result (hit@1) or among the top 3 (hit@3). **off-topic refused** is how many of the 4 unanswerable questions the guard stopped before any model call.
- This is the offline hash embedder, which already matches on words, so keyword search has little to add here. Keyword search matters most next to a real embedding model, where exact terms are the thing that gets blurred. The unit tests show that case with a meaning-blind embedder: hybrid search still finds `ekstensi 100` because BM25 does.
- Keyword mode refuses all 4 off-topic questions because its guard (share of the question's words found in a chunk) is stricter than the cosine score of the hash embedder. In `hybrid` mode a chunk passes if **either** guard passes, which keeps paraphrased questions answerable but lets "harga saham perusahaan hari ini" through on shared words. With a model key, the `TIDAK_ADA` layer is what catches it.
- The question set is small and written by the author. It is a smoke test, not a benchmark. A harder set (paraphrases, typos, mixed languages) would separate the modes properly.
- Numbers for the Gemini embedder are not published here because they have not been measured. Run `GEMINI_API_KEY=... npm run ingest && npm run eval` and tune `MIN_SCORE` for your documents.

## Tests

```bash
npm test          # 30 tests
npm run typecheck
```

They cover chunking, the embedder, BM25 and rank fusion, retrieval accuracy and refusals on the sample set, the prompt that is sent to the model, the HTTP API (validation and rate limit) and the Gemini and Claude request formats. The provider calls are **mocked**, so no key or network is needed, and the real APIs were not called while building this.

## Limits and next steps

- Brute-force search is exact but scans every vector. Past tens of thousands of chunks, move the store to pgvector, Qdrant or sqlite-vec (only `src/store.ts` changes).
- Only `.md` files. PDFs and web pages need an extraction step before chunking.
- Hybrid search fuses by rank only. A cross-encoder reranker on the top 20 would improve the final order further.
- No reranking and no conversation memory: each question stands alone.
- The sample company and its policies are fictional.
- `/api/ask` has a simple in-memory rate limit per IP. A public deployment needs a real one, plus a spend cap on the API key.

## Project layout

```
src/chunk.ts    split markdown into chunks
src/embed.ts    hash embedder + Gemini embeddings
src/bm25.ts     keyword search (BM25) and keyword coverage
src/store.ts    SQLite store: vectors, cosine + BM25 scores
src/llm.ts      Claude and Gemini adapters (plain fetch, no SDK)
src/rag.ts      ingest, hybrid ranking (RRF), guard, prompt, answer
src/app.ts      Express API
src/cli.ts      ingest / ask / eval
public/         one-page web UI
docs/sample/    the fictional handbook
eval/           evaluation questions
test/           Vitest + Supertest
```

## License

MIT

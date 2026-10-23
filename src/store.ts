import { createRequire } from 'node:module';
import type { DatabaseSync as Db } from 'node:sqlite';
import { Bm25 } from './bm25.js';
import type { Chunk } from './chunk.js';

// Loaded with require so bundlers that do not know node:sqlite yet (Vitest, older Vite) leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface Hit {
  id: number;
  doc: string;
  heading: string;
  /** Page number for PDFs, otherwise null. */
  page: number | null;
  text: string;
  /** Cosine similarity between the question and the chunk (meaning-based). */
  score: number;
  /** BM25 keyword score (word-based). */
  bm25: number;
  /** Share of the question's weighted words found in the chunk, 0 to 1. */
  coverage: number;
}

interface Row {
  id: number;
  doc: string;
  heading: string;
  page: number | null;
  text: string;
  vector: Float32Array;
}

/** Text that is embedded and keyword-indexed for a chunk: the heading goes in front so short passages keep their topic. */
export const indexText = (c: { doc: string; heading: string; text: string }) => `${c.doc.replace(/\.(md|pdf|txt)$/, '')} > ${c.heading}\n${c.text}`;

/**
 * A deliberately small vector store: chunks and their embeddings live in SQLite (Node's built-in
 * `node:sqlite`, so there is nothing native to install), vectors as float32 blobs. Search is a
 * brute-force dot product plus BM25 over the same text, which is exact and fast up to tens of
 * thousands of chunks. Beyond that, swap this class for pgvector, Qdrant or sqlite-vec; the rest of
 * the code only uses replaceAll/scoreAll.
 */
export class VectorStore {
  private db: Db;
  private cache: { rows: Row[]; bm25: Bm25 } | null = null;

  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc TEXT NOT NULL,
        heading TEXT NOT NULL,
        page INTEGER,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
    `);
    // Indexes made by an earlier version have no page column.
    const columns = this.db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'page')) this.db.exec('ALTER TABLE chunks ADD COLUMN page INTEGER');
  }

  get embedderName(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'embedder'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  }

  docCount(): number {
    return (this.db.prepare('SELECT COUNT(DISTINCT doc) AS n FROM chunks').get() as { n: number }).n;
  }

  /** Replace the whole index (ingest always rebuilds, so removed documents disappear). */
  replaceAll(chunks: Chunk[], vectors: number[][], embedderName: string): void {
    const insert = this.db.prepare('INSERT INTO chunks (doc, heading, page, text, embedding) VALUES (?, ?, ?, ?, ?)');
    this.cache = null;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM chunks');
      chunks.forEach((c, i) => insert.run(c.doc, c.heading, c.page ?? null, c.text, new Uint8Array(new Float32Array(vectors[i]!).buffer)));
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedder', ?)").run(embedderName);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private load() {
    if (!this.cache) {
      const raw = this.db.prepare('SELECT id, doc, heading, page, text, embedding FROM chunks').all() as unknown as (Omit<Row, 'vector'> & { embedding: Uint8Array })[];
      const rows: Row[] = raw.map(({ embedding, ...r }) => ({ ...r, vector: new Float32Array(embedding.slice().buffer) }));
      this.cache = { rows, bm25: new Bm25(rows.map(indexText)) };
    }
    return this.cache;
  }

  /** Every chunk with its meaning-based (cosine) and word-based (BM25) scores for one question. */
  scoreAll(queryVector: number[], queryText: string): Hit[] {
    const { rows, bm25 } = this.load();
    const kw = bm25.score(queryText);
    return rows.map((r, i) => {
      let dot = 0;
      for (let j = 0; j < r.vector.length; j++) dot += r.vector[j]! * (queryVector[j] ?? 0);
      return { id: r.id, doc: r.doc, heading: r.heading, page: r.page, text: r.text, score: dot, bm25: kw[i]!.bm25, coverage: kw[i]!.coverage };
    });
  }

  close(): void {
    this.db.close();
  }
}

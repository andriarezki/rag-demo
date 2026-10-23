import Database from 'better-sqlite3';
import { Bm25 } from './bm25.js';
import type { Chunk } from './chunk.js';

export interface Hit {
  id: number;
  doc: string;
  heading: string;
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
  text: string;
  embedding: Buffer;
}

/** Text that is embedded and keyword-indexed for a chunk: the heading goes in front so short passages keep their topic. */
export const indexText = (c: { doc: string; heading: string; text: string }) => `${c.doc.replace(/\.md$/, '')} > ${c.heading}\n${c.text}`;

/**
 * A deliberately small vector store: chunks and their embeddings live in SQLite
 * (vectors as float32 blobs) and search is a brute-force dot product (plus BM25 over
 * the same text), which is exact and fast up to tens of thousands of chunks. Beyond that, swap this class
 * for pgvector, Qdrant or sqlite-vec; the rest of the code only uses replaceAll/scoreAll.
 */
export class VectorStore {
  private db: Database.Database;
  private cache: { rows: Row[]; bm25: Bm25 } | null = null;

  constructor(file = ':memory:') {
    this.db = new Database(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc TEXT NOT NULL,
        heading TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
    `);
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
    const insert = this.db.prepare('INSERT INTO chunks (doc, heading, text, embedding) VALUES (?, ?, ?, ?)');
    this.cache = null;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks').run();
      chunks.forEach((c, i) => insert.run(c.doc, c.heading, c.text, Buffer.from(new Float32Array(vectors[i]!).buffer)));
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedder', ?)").run(embedderName);
    })();
  }

  private load() {
    if (!this.cache) {
      const rows = this.db.prepare('SELECT id, doc, heading, text, embedding FROM chunks').all() as Row[];
      this.cache = { rows, bm25: new Bm25(rows.map(indexText)) };
    }
    return this.cache;
  }

  /** Every chunk with its meaning-based (cosine) and word-based (BM25) scores for one question. */
  scoreAll(queryVector: number[], queryText: string): Hit[] {
    const { rows, bm25 } = this.load();
    const kw = bm25.score(queryText);
    return rows.map((r, i) => {
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      let dot = 0;
      for (let j = 0; j < v.length; j++) dot += v[j]! * (queryVector[j] ?? 0);
      return { id: r.id, doc: r.doc, heading: r.heading, text: r.text, score: dot, bm25: kw[i]!.bm25, coverage: kw[i]!.coverage };
    });
  }

  close(): void {
    this.db.close();
  }
}

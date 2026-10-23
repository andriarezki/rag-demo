import Database from 'better-sqlite3';
import type { Chunk } from './chunk.js';

export interface Hit {
  id: number;
  doc: string;
  heading: string;
  text: string;
  score: number;
}

/**
 * A deliberately small vector store: chunks and their embeddings live in SQLite
 * (vectors as float32 blobs) and search is a brute-force dot product, which is
 * exact and fast up to tens of thousands of chunks. Beyond that, swap this class
 * for pgvector, Qdrant or sqlite-vec; the rest of the code only uses add/search.
 */
export class VectorStore {
  private db: Database.Database;

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
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks').run();
      chunks.forEach((c, i) => insert.run(c.doc, c.heading, c.text, Buffer.from(new Float32Array(vectors[i]!).buffer)));
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedder', ?)").run(embedderName);
    })();
  }

  search(query: number[], k: number): Hit[] {
    const rows = this.db.prepare('SELECT id, doc, heading, text, embedding FROM chunks').all() as {
      id: number;
      doc: string;
      heading: string;
      text: string;
      embedding: Buffer;
    }[];
    const hits = rows.map((r) => {
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i]! * (query[i] ?? 0);
      return { id: r.id, doc: r.doc, heading: r.heading, text: r.text, score: dot };
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  close(): void {
    this.db.close();
  }
}

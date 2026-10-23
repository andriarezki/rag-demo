import { tokenize } from './embed.js';

export interface KeywordScore {
  /** Okapi BM25 score of the chunk for the query. */
  bm25: number;
  /**
   * Share of the query's weight that the chunk covers, 0 to 1. Each query word weighs its
   * rarity (IDF); words that appear nowhere in the documents get the highest weight, so a
   * question made of unknown words scores low everywhere. Used by the "is this on topic" guard.
   */
  coverage: number;
}

const K1 = 1.5;
const B = 0.75;

/**
 * Keyword search (BM25) over the same text that is embedded. It finds what meaning-based search
 * tends to miss: exact words such as "ekstensi 100", an email address or a channel name.
 */
export class Bm25 {
  private readonly tf: Map<string, number>[];
  private readonly len: number[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(texts: string[]) {
    this.tf = texts.map((t) => {
      const m = new Map<string, number>();
      for (const w of tokenize(t)) m.set(w, (m.get(w) ?? 0) + 1);
      return m;
    });
    this.len = this.tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
    for (const m of this.tf) for (const w of m.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
  }

  private idf(word: string): number {
    const n = this.df.get(word) ?? 0;
    return Math.log(1 + (this.tf.length - n + 0.5) / (n + 0.5));
  }

  /** One score per document, in the order the texts were given. */
  score(query: string): KeywordScore[] {
    const words = [...new Set(tokenize(query))];
    const total = words.reduce((s, w) => s + this.idf(w), 0) || 1;
    return this.tf.map((m, i) => {
      let bm25 = 0;
      let covered = 0;
      for (const w of words) {
        const f = m.get(w);
        if (!f) continue;
        const idf = this.idf(w);
        covered += idf;
        bm25 += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * this.len[i]!) / this.avgLen));
      }
      return { bm25, coverage: covered / total };
    });
  }
}

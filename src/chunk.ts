export interface Chunk {
  doc: string;
  heading: string;
  text: string;
  position: number;
  /** Page number for PDFs (1-based); undefined for markdown and text files. */
  page?: number;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/** Split text that is longer than `max` into pieces at sentence boundaries. */
function splitLong(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph];
  const out: string[] = [];
  let cur = '';
  for (const sentence of paragraph.split(SENTENCE_SPLIT)) {
    if (cur && cur.length + sentence.length + 1 > max) {
      out.push(cur);
      cur = sentence;
    } else {
      cur = cur ? `${cur} ${sentence}` : sentence;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Turn one markdown file into chunks. Every chunk stays inside a single heading
 * section and carries that heading, so a passage keeps its context after it is
 * cut out of the document. Chunks from the same section overlap a little so a
 * sentence on the boundary is not lost.
 */
export function chunkMarkdown(doc: string, markdown: string, max = 700, overlap = 120): Chunk[] {
  const sections: { heading: string; body: string[] }[] = [{ heading: doc, body: [] }];
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) sections.push({ heading: (h[1] ?? '').trim(), body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const paragraphs = section.body
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .flatMap((p) => splitLong(p, max));

    let cur = '';
    let tail = '';
    const flush = () => {
      if (!cur) return;
      chunks.push({ doc, heading: section.heading, text: cur, position: chunks.length });
      tail = cur.slice(-overlap);
      cur = '';
    };
    for (const p of paragraphs) {
      if (cur && cur.length + p.length + 1 > max) flush();
      cur = cur ? `${cur} ${p}` : tail ? `…${tail} ${p}` : p;
    }
    flush();
  }
  return chunks;
}

/**
 * Chunk the text of one PDF page. PDFs have no reliable headings, so the page number is the label.
 * Text is cut at sentence boundaries into pieces of at most `max` characters, with a small overlap.
 */
export function chunkPage(doc: string, page: number, text: string, max = 700, overlap = 120): Chunk[] {
  const sentences = splitLong(text.replace(/\s+/g, ' ').trim(), max);
  const chunks: Chunk[] = [];
  let tail = '';
  for (const s of sentences) {
    if (!s) continue;
    chunks.push({ doc, heading: `halaman ${page}`, text: tail ? `…${tail} ${s}` : s, position: 0, page });
    tail = s.slice(-overlap);
  }
  return chunks;
}

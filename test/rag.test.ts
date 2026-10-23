import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkMarkdown, chunkPage } from '../src/chunk.js';
import { extractPdfPages } from '../src/pdf.js';
import { geminiEmbedder, hashEmbedder, pickEmbedder, type Embedder } from '../src/embed.js';
import { claude, gemini, pickLlm, type Llm } from '../src/llm.js';
import { ask, buildPrompt, ingest, NOT_FOUND, rank, relevance, retrieve } from '../src/rag.js';
import { Bm25 } from '../src/bm25.js';
import { VectorStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const DOCS = 'docs/sample';
const embedder = hashEmbedder();

async function indexed() {
  const store = new VectorStore(':memory:');
  await ingest(DOCS, store, embedder);
  return store;
}

afterEach(() => vi.restoreAllMocks());

describe('chunkMarkdown', () => {
  const md = '# Title\n\nIntro line.\n\n## Part A\n\nFirst paragraph of A.\n\nSecond paragraph of A.\n\n## Part B\n\nOnly B.';

  it('keeps each chunk inside one heading and stores the heading', () => {
    const chunks = chunkMarkdown('doc.md', md);
    expect(chunks.map((c) => c.heading)).toEqual(['Title', 'Part A', 'Part B']);
    expect(chunks[1]!.text).toContain('Second paragraph of A.');
    expect(chunks[2]!.text).toBe('Only B.');
  });

  it('splits long sections at sentence boundaries and overlaps the pieces', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Kalimat nomor ${i} menjelaskan satu hal penting.`).join(' ');
    const chunks = chunkMarkdown('long.md', `# T\n\n${long}`, 300, 60);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300 + 60 + 2);
    expect(chunks[1]!.text.startsWith('…')).toBe(true);
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
  });

  it('ignores empty sections', () => {
    expect(chunkMarkdown('e.md', '# A\n\n## B\n\n')).toEqual([]);
  });
});

describe('hash embedder', () => {
  it('is deterministic and unit length', async () => {
    const [a] = await embedder.embed(['laptop hilang dicuri'], 'query');
    const [b] = await embedder.embed(['laptop hilang dicuri'], 'query');
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 5);
  });

  it('scores a text higher against itself than against an unrelated one', async () => {
    const [q, same, other] = await embedder.embed(['reset password email', 'cara reset password email kantor', 'jadwal cuti tahunan'], 'document');
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(q!, same!)).toBeGreaterThan(dot(q!, other!));
  });
});

describe('retrieval over the sample documents', () => {
  const cases = JSON.parse(readFileSync('eval/questions.json', 'utf8')) as { q: string; doc: string | null }[];

  it('finds the right document in the top 3 for every answerable question', async () => {
    const store = await indexed();
    for (const c of cases.filter((x) => x.doc)) {
      const hits = await retrieve(c.q, store, embedder, 3);
      expect(hits.map((h) => h.doc), c.q).toContain(c.doc);
    }
  });

  it('refuses most off-topic questions before calling any model', async () => {
    const store = await indexed();
    const llm: Llm = { name: 'spy', complete: vi.fn(async () => 'should not be called') };
    const off = cases.filter((x) => !x.doc);
    const results = await Promise.all(off.map((c) => ask(c.q, store, embedder, llm)));
    const refused = results.filter((r) => r.mode === 'refused').length;
    expect(refused).toBeGreaterThanOrEqual(off.length - 1);
  });

  it('refuses to search an index built with a different embedder', async () => {
    const store = await indexed();
    await expect(retrieve('apa saja', store, { ...embedder, name: 'other' })).rejects.toThrow(/built with/);
  });

  it('errors clearly when nothing is indexed', async () => {
    await expect(retrieve('apa saja', new VectorStore(':memory:'), embedder)).rejects.toThrow(/empty/);
  });
});

describe('keyword search (BM25)', () => {
  const docs = ['laptop hilang lapor ke ekstensi 100', 'cuti tahunan 12 hari', 'reimbursement dibayar hari Jumat'];

  it('ranks the chunk that contains the rare exact words first', () => {
    const s = new Bm25(docs).score('ekstensi 100');
    expect(s[0]!.bm25).toBeGreaterThan(s[1]!.bm25);
    expect(s[0]!.coverage).toBeCloseTo(1, 5);
    expect(s[1]!.coverage).toBe(0);
  });

  it('gives zero coverage to a question made of words nobody uses', () => {
    const s = new Bm25(docs).score('resep nasi goreng');
    expect(s.every((x) => x.bm25 === 0 && x.coverage === 0)).toBe(true);
  });

  it('weights a rare word above a common one', () => {
    const s = new Bm25(docs).score('hari ekstensi');
    expect(s[0]!.coverage).toBeGreaterThan(s[2]!.coverage); // "ekstensi" is rarer than "hari"
  });

  it('handles an empty question and an empty corpus', () => {
    expect(new Bm25(docs).score('').every((x) => x.bm25 === 0)).toBe(true);
    expect(new Bm25([]).score('apa saja')).toEqual([]);
  });
});

describe('hybrid search', () => {
  /** Meaning-blind embedder: stable pseudo-random vectors, so only the keyword side can find the answer. */
  const noise: Embedder = {
    name: 'noise',
    defaultMinScore: -1,
    async embed(texts) {
      return texts.map((t) => {
        let h = 7;
        for (const ch of t) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
        return Array.from({ length: 16 }, (_, i) => Math.sin(h * (i + 1)));
      });
    },
  };

  it('keyword search rescues a question the embeddings cannot answer', async () => {
    const store = new VectorStore(':memory:');
    await ingest(DOCS, store, noise);
    const hybrid = await retrieve('ekstensi 100', store, noise, 3, 'hybrid');
    const keyword = await retrieve('ekstensi 100', store, noise, 3, 'keyword');
    expect(hybrid[0]!.doc).toBe('03-laptop-dan-perangkat.md');
    expect(keyword[0]!.doc).toBe('03-laptop-dan-perangkat.md');
  });

  it('fuses two rankings by rank, not by raw score', () => {
    const h = (id: number, score: number, bm25: number) => ({ id, doc: 'd', heading: 'h', page: null, text: 't', score, bm25, coverage: 0 });
    const hits = [h(1, 0.9, 0), h(2, 0.5, 9), h(3, 0.4, 1)];
    expect(rank(hits, 'vector').map((x) => x.id)).toEqual([1, 2, 3]);
    expect(rank(hits, 'keyword').map((x) => x.id)).toEqual([2, 3]);
    expect(rank(hits, 'hybrid')[0]!.id).toBe(2); // first in keyword, second in meaning
  });

  it('applies the on-topic guard per mode', () => {
    const hit = { id: 1, doc: 'd', heading: 'h', page: null, text: 't', score: 0.05, bm25: 2, coverage: 0.9 };
    expect(relevance(hit, 'vector', 0.12)).toBeNull();
    expect(relevance(hit, 'keyword', 0.12)).toBe('keyword');
    expect(relevance(hit, 'hybrid', 0.12)).toBe('keyword');
    expect(relevance({ ...hit, score: 0.5 }, 'hybrid', 0.12)).toBe('both');
    expect(relevance({ ...hit, coverage: 0 }, 'hybrid', 0.12)).toBeNull();
  });

  it('reports which search found each source', async () => {
    const store = await indexed();
    const a = await ask('ekstensi 100', store, embedder, null);
    expect(a.sources[0]!.doc).toBe('03-laptop-dan-perangkat.md');
    expect(['keyword', 'both']).toContain(a.sources[0]!.via);
  });
});

describe('PDF and text files', () => {
  const pdf = 'test/fixtures/handbook.pdf';

  function docsDir() {
    const dir = mkdtempSync(join(tmpdir(), 'rag-docs-'));
    mkdirSync(join(dir, 'jurnal'));
    copyFileSync(pdf, join(dir, 'jurnal', 'handbook.pdf'));
    writeFileSync(join(dir, 'catatan.txt'), 'Rapat mingguan diadakan setiap hari Selasa pukul 10.00 di ruang utama.');
    return dir;
  }

  it('extracts the text of each page in order', async () => {
    const pages = await extractPdfPages(pdf);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('12 hari cuti');
    expect(pages[1]).toContain('laptop hilang');
  });

  it('chunks a page and labels it with the page number', () => {
    const chunks = chunkPage('a.pdf', 3, 'Kalimat pertama. '.repeat(100), 300, 50);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.page === 3 && c.heading === 'halaman 3')).toBe(true);
  });

  it('indexes PDFs in subfolders and cites the right page', async () => {
    const store = new VectorStore(':memory:');
    const report = await ingest(docsDir(), store, embedder);
    expect(report).toMatchObject({ docs: 2, empty: [], failed: [] });
    const a = await ask('Jika laptop dicuri lapor berapa jam?', store, embedder, null);
    expect(a.sources[0]).toMatchObject({ doc: 'jurnal/handbook.pdf', page: 2 });
    const b = await ask('Berapa hari cuti tahunan?', store, embedder, null);
    expect(b.sources[0]).toMatchObject({ doc: 'jurnal/handbook.pdf', page: 1 });
    const c = await ask('Kapan rapat mingguan diadakan?', store, embedder, null);
    expect(c.sources[0]!.doc).toBe('catatan.txt');
  });

  it('reports unreadable files instead of stopping the whole ingest', async () => {
    const dir = docsDir();
    writeFileSync(join(dir, 'rusak.pdf'), 'ini bukan pdf');
    const report = await ingest(dir, new VectorStore(':memory:'), embedder);
    expect(report.docs).toBe(2);
    expect(report.failed.map((f) => f.file)).toEqual(['rusak.pdf']);
  });

  it('says so when nothing readable is found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-empty-'));
    writeFileSync(join(dir, 'kosong.txt'), '   ');
    await expect(ingest(dir, new VectorStore(':memory:'), embedder)).rejects.toThrow(/No readable/);
  });
});

describe('ask', () => {
  it('returns the best passage when there is no model key', async () => {
    const store = await indexed();
    const a = await ask('Berapa hari cuti tahunan untuk karyawan tetap?', store, embedder, null);
    expect(a.mode).toBe('extractive');
    expect(a.sources[0]!.doc).toBe('04-cuti-dan-izin.md');
    expect(a.answer).toContain('12 hari');
  });

  it('sends numbered passages to the model and returns its cited answer', async () => {
    const store = await indexed();
    const complete = vi.fn(async () => 'Karyawan tetap mendapat 12 hari cuti per tahun [1].');
    const a = await ask('Berapa hari cuti tahunan untuk karyawan tetap?', store, embedder, { name: 'fake', complete });
    expect(a.mode).toBe('llm');
    expect(a.answer).toContain('[1]');
    const [system, user] = complete.mock.calls[0] as unknown as [string, string];
    expect(system).toContain('ONLY');
    expect(user).toContain('[1] (04-cuti-dan-izin.md');
    expect(user).toContain('Question: Berapa hari cuti');
  });

  it('turns the model TIDAK_ADA reply into a refusal but keeps the sources for inspection', async () => {
    const store = await indexed();
    const a = await ask('Berapa hari cuti tahunan untuk karyawan tetap?', store, embedder, { name: 'fake', complete: async () => 'TIDAK_ADA' });
    expect(a.mode).toBe('refused');
    expect(a.answer).toBe(NOT_FOUND);
    expect(a.sources.length).toBeGreaterThan(0);
  });

  it('labels passages and marks them as data in the prompt', () => {
    const p = buildPrompt('q?', [{ n: 1, doc: 'a.md', heading: 'H', page: null, text: 'isi', score: 0.9, via: 'meaning' }]);
    expect(p).toBe('Passages:\n\n[1] (a.md > H)\nisi\n\nQuestion: q?');
  });
});

describe('provider adapters (mocked fetch)', () => {
  it('claude sends the Messages API shape and reads the text block', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: ' halo ' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await claude('k', 'm1').complete('sys', 'usr');
    expect(out).toBe('halo');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'm1', system: 'sys', messages: [{ role: 'user', content: 'usr' }] });
  });

  it('gemini sends the key in a header, not in the URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'jawaban' }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await gemini('secret', 'g1').complete('sys', 'usr')).toBe('jawaban');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
  });

  it('gemini embeddings batch the requests and normalise the vectors', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      const n = (JSON.parse(init.body as string).requests as unknown[]).length;
      return new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => ({ values: [3, 4] })) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const e = geminiEmbedder('k', 'em');
    const out = await e.embed(Array.from({ length: 120 }, (_, i) => `t${i}`), 'document');
    expect(out).toHaveLength(120);
    expect(out[0]).toEqual([0.6, 0.8]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('surfaces API errors instead of returning empty answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 403 })));
    await expect(claude('k').complete('s', 'u')).rejects.toThrow(/403.*bad key/);
  });

  it('picks providers from the environment', () => {
    expect(pickLlm({})).toBeNull();
    expect(pickLlm({ GEMINI_API_KEY: 'g' })?.name).toMatch(/^gemini:/);
    expect(pickLlm({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })?.name).toMatch(/^claude:/);
    expect(pickEmbedder({}).name).toBe('hash-1024');
    expect(pickEmbedder({ GEMINI_API_KEY: 'g' }).name).toMatch(/^gemini:/);
  });
});

describe('HTTP API', () => {
  async function app(rateLimit?: number) {
    return createApp({ store: await indexed(), embedder, llm: null, rateLimit });
  }

  it('reports what is indexed', async () => {
    const res = await request(await app()).get('/api/info');
    expect(res.body).toMatchObject({ documents: 7, embedder: 'hash-1024', answerModel: null, search: 'hybrid' });
    expect(res.body.chunks).toBeGreaterThan(7);
  });

  it('shows the deployment name and subtitle', async () => {
    const a = createApp({ store: await indexed(), embedder, llm: null, name: 'Pagewise', subtitle: 'Tanya isi dokumen.', examples: ['Contoh?'] });
    expect((await request(a).get('/api/info')).body).toMatchObject({ name: 'Pagewise', subtitle: 'Tanya isi dokumen.', examples: ['Contoh?'] });
  });

  it('answers a question with sources', async () => {
    const res = await request(await app()).post('/api/ask').send({ question: 'Berapa lama saya harus melapor kalau laptop dicuri?' });
    expect(res.status).toBe(200);
    expect(res.body.sources[0].doc).toBe('03-laptop-dan-perangkat.md');
  });

  it('validates the question', async () => {
    const a = await app();
    expect((await request(a).post('/api/ask').send({})).status).toBe(400);
    expect((await request(a).post('/api/ask').send({ question: 'x'.repeat(301) })).status).toBe(400);
  });

  it('rate limits per IP', async () => {
    const a = await app(2);
    const q = { question: 'Berapa hari cuti tahunan?' };
    expect((await request(a).post('/api/ask').send(q)).status).toBe(200);
    expect((await request(a).post('/api/ask').send(q)).status).toBe(200);
    expect((await request(a).post('/api/ask').send(q)).status).toBe(429);
  });
});

describe('pilot options: login and question log', () => {
  it('asks for a login when credentials are configured', async () => {
    const app = createApp({ store: await indexed(), embedder, llm: null, auth: { user: 'peneliti', password: 'rahasia-123' } });
    expect((await request(app).get('/api/info')).status).toBe(401);
    expect((await request(app).get('/api/info').auth('peneliti', 'salah')).status).toBe(401);
    expect((await request(app).get('/api/info').auth('peneliti', 'rahasia-123')).status).toBe(200);
    expect((await request(app).post('/api/ask').send({ question: 'Berapa hari cuti?' })).status).toBe(401);
  });

  it('records each question as a JSON line when a log file is set', async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'rag-log-')), 'logs', 'questions.log');
    const app = createApp({ store: await indexed(), embedder, llm: null, logFile });
    await request(app).post('/api/ask').send({ question: 'Berapa hari cuti tahunan untuk karyawan tetap?' });
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ q: 'Berapa hari cuti tahunan untuk karyawan tetap?', mode: 'extractive' });
    expect(lines[0].sources[0].doc).toBe('04-cuti-dan-izin.md');
  });
});

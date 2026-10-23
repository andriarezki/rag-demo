import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { chunkMarkdown } from '../src/chunk.js';
import { geminiEmbedder, hashEmbedder, pickEmbedder } from '../src/embed.js';
import { claude, gemini, pickLlm, type Llm } from '../src/llm.js';
import { ask, buildPrompt, ingest, NOT_FOUND, retrieve } from '../src/rag.js';
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
    const p = buildPrompt('q?', [{ n: 1, doc: 'a.md', heading: 'H', text: 'isi', score: 0.9 }]);
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
    expect(res.body).toMatchObject({ documents: 7, embedder: 'hash-1024', answerModel: null });
    expect(res.body.chunks).toBeGreaterThan(7);
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

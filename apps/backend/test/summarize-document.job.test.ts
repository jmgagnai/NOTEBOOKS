import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import {
  createAppEventSubscriber,
  type AppEvent,
  type AppEventSubscriber,
} from '../src/events/bus.js';
import { createOpenRouterCompleter } from '../src/llm/openrouter.js';
import { DEFAULT_TASK_MODELS } from '../src/llm/models.js';
import { listDocuments } from '../src/documents/repository.js';
import { runSummarizeDocumentJob } from '../src/ingestion/summarize-document.js';

/**
 * Seam-2 tests for ingestion stage 2 (NBK-7) — the same seam as
 * test/convert-to-markdown.job.test.ts: invoke the pg_boss job handler
 * directly with a constructed payload, against a real Postgres, and assert
 * on the resulting database rows and the app events actually published over
 * LISTEN/NOTIFY.
 *
 * OpenRouter is stubbed at its *HTTP* boundary, not at the module boundary:
 * the job runs the real `createOpenRouterCompleter` with a stub `fetch`. So
 * request construction (auth header, model id, message roles) and response
 * parsing are under test here too, and only the network itself is fake.
 *
 * No MinIO container: stage 2 reads the Converted Markdown off the Document
 * Version (per GLOSSARY.md, "the single input every later Stage ... reads
 * from — nothing downstream re-reads the original upload"), so object
 * storage is not in this stage's path at all.
 */
describe('summarize-document job', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: Pool;
  let subscriber: AppEventSubscriber;
  let received: AppEvent[];
  let stopCollecting: () => void;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(pgContainer.getConnectionUri());
    await runMigrations(pool);
    subscriber = await createAppEventSubscriber(pgContainer.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    stopCollecting?.();
    await subscriber.close();
    await pool.end();
    await pgContainer.stop();
  });

  beforeEach(() => {
    stopCollecting?.();
    received = [];
    stopCollecting = subscriber.subscribe((event) => received.push(event));
  });

  async function waitForEvents(predicate: (events: AppEvent[]) => boolean): Promise<AppEvent[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate(received)) return received;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Expected app events never arrived. Got: ${JSON.stringify(received)}`);
  }

  interface SeededVersion {
    notebookId: string;
    documentId: string;
    versionId: string;
  }

  /**
   * Inserts the exact state ingestion stage 1 leaves behind: a Document
   * Version whose status is "converted" and whose `markdown` holds the
   * Converted Markdown.
   */
  async function seedConvertedVersion(filename: string, markdown: string): Promise<SeededVersion> {
    const { rows: notebookRows } = await pool.query<{ id: string }>(
      'INSERT INTO notebooks (title) VALUES ($1) RETURNING id',
      [`Notebook for ${filename}`],
    );
    const notebookId = notebookRows[0].id;
    const { rows: documentRows } = await pool.query<{ id: string }>(
      'INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id',
      [notebookId, filename],
    );
    const documentId = documentRows[0].id;
    const { rows: versionRows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions
         (document_id, version_number, mime_type, size_bytes, storage_key, ingestion_status, markdown, converted_at)
       VALUES ($1, 1, 'text/markdown', $2, $3, 'converted', $4, now()) RETURNING id`,
      [
        documentId,
        Buffer.byteLength(markdown),
        `notebooks/${notebookId}/${documentId}-${filename}`,
        markdown,
      ],
    );
    return { notebookId, documentId, versionId: versionRows[0].id };
  }

  async function readVersion(versionId: string) {
    const { rows } = await pool.query<{
      ingestion_status: string;
      markdown: string | null;
      metadata: Record<string, unknown> | null;
      chat_snippet: string | null;
      executive_summary: string | null;
      abstract: string | null;
      ingestion_error: string | null;
      summarized_at: Date | null;
      artifact_warnings: unknown;
      section_summaries: unknown;
    }>(
      `SELECT ingestion_status, markdown, metadata, chat_snippet, executive_summary, abstract,
              ingestion_error, summarized_at, artifact_warnings, section_summaries
       FROM document_versions WHERE id = $1`,
      [versionId],
    );
    return rows[0];
  }

  /**
   * Which generation task a call is for. Derived from the system prompt
   * rather than the model id, because several tasks legitimately default to
   * the *same* model — the per-task configuration is a slot, not a promise
   * that five different models are in use.
   */
  type Task =
    'metadata' | 'sectionSummary' | 'chatSnippet' | 'executiveSummary' | 'abstract' | 'fold';

  function classify(system: string): Task {
    if (system.includes('extract bibliographic metadata')) return 'metadata';
    if (system.includes('merge several section summaries')) return 'fold';
    if (system.includes('summarize one section')) return 'sectionSummary';
    if (system.includes('a Chat Snippet')) return 'chatSnippet';
    if (system.includes('an Executive Summary')) return 'executiveSummary';
    if (system.includes('an Abstract')) return 'abstract';
    throw new Error(`Could not tell which task this system prompt is for: ${system.slice(0, 120)}`);
  }

  /** One recorded OpenRouter HTTP call, decoded. */
  interface RecordedCall {
    url: string;
    authorization: string | null;
    model: string;
    task: Task;
    system: string;
    user: string;
  }

  /**
   * A stub standing exactly where the network does. `reply` is handed the
   * decoded request and returns the assistant message content OpenRouter
   * would have produced, so a test can script per-task answers without
   * knowing anything about how the completer frames its HTTP call.
   */
  function stubOpenRouter(reply: (call: RecordedCall) => string) {
    const calls: RecordedCall[] = [];
    const fetchStub: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
      const call: RecordedCall = {
        url: String(input),
        authorization: headers.get('authorization'),
        model: body.model,
        task: classify(system),
        system,
        user: body.messages.find((m) => m.role === 'user')?.content ?? '',
      };
      calls.push(call);
      return new Response(
        JSON.stringify({
          id: 'gen-stub',
          choices: [{ message: { role: 'assistant', content: reply(call) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return { calls, fetchStub };
  }

  /** `count` distinct words, so a scripted answer can hit a word-count range. */
  function words(count: number): string {
    return Array.from({ length: count }, (_, i) => `word${i + 1}`).join(' ');
  }

  /**
   * A section body long enough to be worth summarizing, carrying `marker` so
   * a test can tell one section's text from another's.
   *
   * Real document sections run to paragraphs; stage 2 passes anything shorter
   * than a summary straight through rather than asking a model to "shorten"
   * it (see the passthrough test below). Fixtures therefore have to be
   * section-sized, or they would exercise the passthrough path by accident.
   */
  function body(marker: string): string {
    return (
      `${marker}\n\n` +
      Array.from(
        { length: 8 },
        (_, i) =>
          `Paragraph ${i + 1} of the ${marker} material, with enough prose to look like a real section.`,
      ).join(' ')
    );
  }

  function depsWith(fetchStub: typeof globalThis.fetch) {
    return {
      pool,
      complete: createOpenRouterCompleter({ apiKey: 'test-key', fetch: fetchStub }),
    };
  }

  it('extracts metadata and stores all three generated artifacts for a single-section Document', async () => {
    const seeded = await seedConvertedVersion(
      'handbook.md',
      `# Field Handbook\n\n${body('soil sampling')}\n`,
    );

    const { calls, fetchStub } = stubOpenRouter((call) => {
      switch (call.task) {
        case 'metadata':
          // Fenced JSON on purpose: models wrap JSON in ```json more often
          // than not, and the extractor has to cope.
          return '```json\n{"title":"Field Handbook","authors":["R. Soil"],"documentType":"handbook","language":"en","publishedOn":"2019","keywords":["soil","sampling"]}\n```';
        case 'sectionSummary':
          return 'Section summary of soil sampling.';
        case 'chatSnippet':
          return words(200);
        case 'executiveSummary':
          return words(700);
        case 'abstract':
          return words(70);
        default:
          throw new Error(`Unexpected task ${call.task}`);
      }
    });

    await runSummarizeDocumentJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('summarized');
    expect(version.ingestion_error).toBeNull();
    expect(version.summarized_at).not.toBeNull();
    // The Converted Markdown is stage 2's input and must survive it untouched.
    expect(version.markdown).toContain('soil sampling');

    expect(version.metadata).toMatchObject({
      title: 'Field Handbook',
      authors: ['R. Soil'],
      documentType: 'handbook',
      language: 'en',
      publishedOn: '2019',
      keywords: ['soil', 'sampling'],
    });

    // The three artifacts are distinct and sized per GLOSSARY.md: Chat
    // Snippet 150-300 words, Abstract 50-100 words, Executive Summary 1-2
    // pages. Asserting the counts (not just "a string is present") is what
    // keeps them non-interchangeable.
    const countWords = (text: string | null): number => (text ?? '').trim().split(/\s+/).length;
    expect(countWords(version.chat_snippet)).toBe(200);
    expect(countWords(version.abstract)).toBe(70);
    expect(countWords(version.executive_summary)).toBe(700);
    expect(version.chat_snippet).not.toBe(version.abstract);

    // Every call went to OpenRouter's chat-completions endpoint with the key
    // as a bearer token — the real completer built these, not a stub.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(call.authorization).toBe('Bearer test-key');
    }

    // Metadata extraction runs first and the three artifacts are each
    // reduced separately — the stage order NBK-7 specifies.
    expect(calls.map((c) => c.task)).toEqual([
      'metadata',
      'sectionSummary',
      'chatSnippet',
      'executiveSummary',
      'abstract',
    ]);

    // Each task went to its own configured model, per NBK-1's "the specific
    // model is fixed per task type via server-side configuration".
    expect(calls.map((c) => c.model)).toEqual([
      DEFAULT_TASK_MODELS.metadata,
      DEFAULT_TASK_MODELS.sectionSummary,
      DEFAULT_TASK_MODELS.chatSnippet,
      DEFAULT_TASK_MODELS.executiveSummary,
      DEFAULT_TASK_MODELS.abstract,
    ]);

    const events = await waitForEvents(
      (all) =>
        all.filter((e) => (e.data as { versionId?: string }).versionId === seeded.versionId)
          .length >= 2,
    );
    const mine = events.filter(
      (e) => (e.data as { versionId?: string }).versionId === seeded.versionId,
    );
    expect(mine.map((e) => (e.data as { status?: string }).status)).toEqual([
      'summarizing',
      'summarized',
    ]);
    expect(mine[0].type).toBe('document-version-status-changed');
    expect(mine[0].topic).toBe(`notebook:${seeded.notebookId}`);
    expect(mine[1].data).toMatchObject({
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      status: 'summarized',
      filename: 'handbook.md',
    });
  });

  // The map-reduce path proper (NBK-1: "each header-delimited section ... is
  // summarized independently, then those section-summaries are reduced into
  // the final Chat Snippet/Executive Summary/Abstract in a second pass").
  // A Document can run past 200 pages, so what matters is that no single
  // prompt ever sees the whole document — which is what this asserts.
  const MULTI_SECTION_MARKDOWN = [
    '# Annual Report 2025',
    '',
    body('board preamble'),
    '',
    '## Revenue',
    '',
    'Revenue grew to 12.4M.',
    body('revenue'),
    '',
    '### Europe',
    '',
    'Europe contributed 4.1M.',
    body('europe'),
    '',
    '## Risks',
    '',
    '| Risk | Severity |',
    '| --- | --- |',
    '| Supply | High |',
    body('risks'),
    '',
    '## Appendix',
    '',
    '```bash',
    '# not a heading',
    'echo hi',
    '```',
    body('appendix'),
    '',
  ].join('\n');

  it('summarizes each header-delimited section independently, then reduces those summaries', async () => {
    const seeded = await seedConvertedVersion('annual-report.md', MULTI_SECTION_MARKDOWN);

    const { calls, fetchStub } = stubOpenRouter((call) => {
      switch (call.task) {
        case 'metadata':
          return '{"title":"Annual Report 2025","authors":[],"documentType":"annual report","language":"en","publishedOn":"2025","keywords":[]}';
        case 'sectionSummary': {
          // Answers are keyed off the section the prompt names, so the
          // assertions below can follow a specific section's summary all the
          // way through to the reduce prompt.
          const named = /^Section: (.*)$/m.exec(call.user)?.[1] ?? '?';
          return `Summary of ${named}.`;
        }
        case 'chatSnippet':
          return words(180);
        case 'executiveSummary':
          return words(600);
        case 'abstract':
          return words(60);
        default:
          throw new Error(`Unexpected task ${call.task}`);
      }
    });

    await runSummarizeDocumentJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    // One map call per header-delimited section, each naming its own heading
    // path. Compared as a set, not a sequence: the map pass runs several
    // calls in flight, so HTTP ordering is not a contract — the ordering
    // that *is* a contract is asserted on the reduce prompt below.
    const sectionCalls = calls.filter((c) => c.task === 'sectionSummary');
    expect(sectionCalls.map((c) => /^Section: (.*)$/m.exec(c.user)?.[1]).sort()).toEqual(
      [
        'Annual Report 2025',
        'Annual Report 2025 > Appendix',
        'Annual Report 2025 > Revenue',
        'Annual Report 2025 > Revenue > Europe',
        'Annual Report 2025 > Risks',
      ].sort(),
    );

    const sectionCallFor = (path: string): string =>
      sectionCalls.find((c) => c.user.startsWith(`Section: ${path}\n`))!.user;

    // Independently: a section's prompt carries that section's text and no
    // other's. This is the property that makes a 200-page document tractable.
    const revenue = sectionCallFor('Annual Report 2025 > Revenue');
    expect(revenue).toContain('Revenue grew to 12.4M.');
    expect(revenue).not.toContain('Europe contributed 4.1M.');
    expect(revenue).not.toContain('Supply');

    // A table stays inside the section it belongs to, structure intact.
    expect(sectionCallFor('Annual Report 2025 > Risks')).toContain('| Supply | High |');

    // A `#` comment inside a fenced code block is not a heading, so the
    // Appendix is one section and keeps its code sample.
    expect(sectionCallFor('Annual Report 2025 > Appendix')).toContain('# not a heading');

    // The reduce pass reads the *section summaries*, in document order —
    // never the document. If the raw text leaked into a reduce prompt the
    // whole map-reduce design would be pointless.
    for (const reduce of calls.filter((c) =>
      ['chatSnippet', 'executiveSummary', 'abstract'].includes(c.task),
    )) {
      expect(reduce.user).toContain('Summary of Annual Report 2025 > Revenue.');
      expect(reduce.user).not.toContain('Revenue grew to 12.4M.');
      expect(reduce.user).not.toContain('| Supply | High |');
      expect(reduce.user.indexOf('Summary of Annual Report 2025 > Revenue.')).toBeLessThan(
        reduce.user.indexOf('Summary of Annual Report 2025 > Risks.'),
      );
      // Metadata extraction ran first, and its result conditions the
      // summaries — they know what kind of document they describe.
      expect(reduce.user).toContain('Type: annual report');
    }

    // 1 metadata + 5 sections + 3 artifacts, with no corrective rewrite
    // because every scripted answer landed inside its word range.
    expect(calls).toHaveLength(9);

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('summarized');
    expect(version.metadata).toMatchObject({ documentType: 'annual report' });
    const countWords = (text: string | null): number => (text ?? '').trim().split(/\s+/).length;
    expect(countWords(version.chat_snippet)).toBe(180);
    expect(countWords(version.executive_summary)).toBe(600);
    expect(countWords(version.abstract)).toBe(60);
  });

  // Found by running stage 2 against the real OpenRouter API: a heading that
  // only introduces subsections ("## 2. Distribution network" above a "###
  // 2.1") has no body of its own, and sending that empty prompt made the
  // section-summary model invent a whole plausible section — fabricated pipe
  // lengths, fabricated customer counts — which then poisoned all three
  // reduced artifacts. An empty section has nothing to summarize, so it must
  // not be asked about.
  it('does not ask the model to summarize a heading that has no body of its own', async () => {
    const seeded = await seedConvertedVersion(
      'outline.md',
      [
        '# Report',
        '',
        '## 2. Distribution network',
        '',
        '### 2.1 Pipe inventory',
        '',
        `The network comprises 3,140 km of mains. ${body('pipe inventory')}`,
        '',
        '## 3. Treatment operations',
        '',
        '### 3.1 Water quality',
        '',
        `All 11,284 samples met primary standards. ${body('water quality')}`,
        '',
      ].join('\n'),
    );

    const { calls, fetchStub } = stubOpenRouter((call) => {
      switch (call.task) {
        case 'metadata':
          return '{"title":"Report","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
        case 'sectionSummary':
          return 'A section summary.';
        case 'chatSnippet':
          return words(200);
        case 'executiveSummary':
          return words(700);
        case 'abstract':
          return words(70);
        default:
          throw new Error(`Unexpected task ${call.task}`);
      }
    });

    await runSummarizeDocumentJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    const sectionPaths = calls
      .filter((c) => c.task === 'sectionSummary')
      .map((c) => /^Section: (.*)$/m.exec(c.user)?.[1])
      .sort();

    // Only the two headings that actually carry prose. "# Report",
    // "## 2. Distribution network" and "## 3. Treatment operations" are
    // structure, not content.
    expect(sectionPaths).toEqual(
      [
        'Report > 2. Distribution network > 2.1 Pipe inventory',
        'Report > 3. Treatment operations > 3.1 Water quality',
      ].sort(),
    );
    // The heading path still names the empty parents, so a summary never
    // loses track of where in the document it came from.
    expect(sectionPaths[0]).toContain('2. Distribution network');
  });

  // Also found against the real API, and the same failure in a subtler
  // form: a section whose body is two lines of front matter ("Prepared by
  // the Office of the Chief Engineer. Published March 2025.") is shorter
  // than the summary it was asked for, so the model padded it out with an
  // invented report — plant counts, budgets, project names, none of them in
  // the document. Text that short is simply passed through verbatim: it
  // cannot be hallucinated, it costs nothing, and the reduce pass gets the
  // actual words rather than a summary of them.
  it('passes a section through verbatim when it is too short to be worth summarizing', async () => {
    const longSection = 'Revenue grew to 12.4M. '.repeat(60);
    const seeded = await seedConvertedVersion(
      'front-matter.md',
      [
        '# Annual Report',
        '',
        'Prepared by the Office of the Chief Engineer. Published March 2025.',
        '',
        '## Revenue',
        '',
        longSection,
        '',
      ].join('\n'),
    );

    const { calls, fetchStub } = stubOpenRouter((call) => {
      switch (call.task) {
        case 'metadata':
          return '{"title":"Annual Report","authors":[],"documentType":"annual report","language":"en","publishedOn":"March 2025","keywords":[]}';
        case 'sectionSummary':
          return 'Summary of the revenue section.';
        case 'chatSnippet':
          return words(200);
        case 'executiveSummary':
          return words(700);
        case 'abstract':
          return words(70);
        default:
          throw new Error(`Unexpected task ${call.task}`);
      }
    });

    await runSummarizeDocumentJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    // Only the substantial section was sent to the model.
    const sectionCalls = calls.filter((c) => c.task === 'sectionSummary');
    expect(sectionCalls).toHaveLength(1);
    expect(sectionCalls[0].user).toContain('Section: Annual Report > Revenue');

    // The short section still reaches the reduce pass — verbatim, under its
    // own heading, so nothing is lost by not summarizing it.
    const reduce = calls.find((c) => c.task === 'abstract')!;
    expect(reduce.user).toContain(
      'Prepared by the Office of the Chief Engineer. Published March 2025.',
    );
    expect(reduce.user).toContain('Summary of the revenue section.');
  });

  // Per GLOSSARY.md the three artifacts are defined partly *by* their sizes:
  // an Abstract that runs to 400 words is not a long Abstract, it is an
  // Executive Summary in the Abstract's field, and it breaks the Document
  // card it exists for. So an answer outside its range is sent back once.
  it('asks for a rewrite when an artifact misses the word range its definition requires', async () => {
    const seeded = await seedConvertedVersion('sprawling.md', '# Sprawl\n\nA single section.\n');

    let abstractAttempts = 0;
    const { calls, fetchStub } = stubOpenRouter((call) => {
      switch (call.task) {
        case 'metadata':
          return '{"title":"Sprawl","authors":[],"documentType":"note","language":"en","publishedOn":null,"keywords":[]}';
        case 'sectionSummary':
          return 'A single section about sprawl.';
        case 'chatSnippet':
          return words(200);
        case 'executiveSummary':
          return words(700);
        case 'abstract':
          abstractAttempts += 1;
          // First answer is four times too long; the corrected one fits.
          return abstractAttempts === 1 ? words(400) : words(80);
        default:
          throw new Error(`Unexpected task ${call.task}`);
      }
    });

    await runSummarizeDocumentJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    const abstractCalls = calls.filter((c) => c.task === 'abstract');
    expect(abstractCalls).toHaveLength(2);
    // The second call says what went wrong, so the model has something to
    // correct rather than another identical chance to guess.
    expect(abstractCalls[1].user).toContain('400 words');
    expect(abstractCalls[1].user).toContain('50-100 word range');
    // Only the artifact that missed is retried — the two that fit are not
    // regenerated.
    expect(calls.filter((c) => c.task === 'chatSnippet')).toHaveLength(1);
    expect(calls.filter((c) => c.task === 'executiveSummary')).toHaveLength(1);

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('summarized');
    expect((version.abstract ?? '').trim().split(/\s+/)).toHaveLength(80);
  });

  // Observed against the real API across several runs: asked for 50-100
  // words, the model returns 99, 108, 112, 126 — in range about half the
  // time, even after the corrective rewrite. For the Abstract that is not
  // cosmetic: it is the artifact GLOSSARY.md defines by being skimmable on a
  // card, and 126 words breaks the card it exists for. So for the two
  // artifacts that are plain prose by definition, the range is enforced
  // deterministically by dropping whole trailing sentences — never by
  // trusting the model to count.
  it('trims a too-long Abstract back into its range at a sentence boundary', async () => {
    const seeded = await seedConvertedVersion('overlong.md', `# Overlong\n\n${body('overlong')}\n`);

    // 12 sentences of 10 words each: 120 words, over the Abstract's 100.
    // Dropping the last two lands on 100 — still above the 50-word floor.
    const sentence = (n: number): string => `Sentence ${n} has exactly ten words in it right here.`;
    const overlongAbstract = Array.from({ length: 12 }, (_, i) => sentence(i + 1)).join(' ');

    const { calls, fetchStub } = stubOpenRouter((call) => {
      switch (call.task) {
        case 'metadata':
          return '{"title":"Overlong","authors":[],"documentType":"note","language":"en","publishedOn":null,"keywords":[]}';
        case 'sectionSummary':
          return 'A section summary.';
        case 'chatSnippet':
          return words(200);
        case 'executiveSummary':
          return words(700);
        case 'abstract':
          // Both the first answer and the rewrite overshoot, which is what
          // actually happens.
          return overlongAbstract;
        default:
          throw new Error(`Unexpected task ${call.task}`);
      }
    });

    await runSummarizeDocumentJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    // The model was given its corrective chance first; the trim is the last
    // resort, not the first.
    expect(calls.filter((c) => c.task === 'abstract')).toHaveLength(2);

    const version = await readVersion(seeded.versionId);
    const abstract = (version.abstract ?? '').trim();
    const count = abstract.split(/\s+/).length;
    expect(count).toBeLessThanOrEqual(100);
    expect(count).toBeGreaterThanOrEqual(50);
    // Cut between sentences, not mid-sentence: a card showing half a clause
    // reads as a bug.
    expect(abstract.endsWith('.')).toBe(true);
    expect(abstract).toContain(sentence(1));
    expect(abstract).not.toContain(sentence(12));

    // The Executive Summary is in range here, so nothing trims it — the
    // structured-Markdown backstop is exercised by its own tests below.
    expect((version.executive_summary ?? '').trim().split(/\s+/)).toHaveLength(700);
  });

  /**
   * The Executive Summary needs a backstop too, and it needs a different one.
   *
   * Its size is part of what it *is* — GLOSSARY.md calls it "a 1-2 page
   * human-facing summary", enforced as 500-1000 words — but it is the one
   * artifact whose brief asks for "short Markdown sections with headings and
   * bullet points", so the Abstract's cut-whole-trailing-sentences trim is
   * wrong for it: it would end a document mid-table, mid-bullet, or on a
   * heading with nothing underneath. Leaving it with *no* enforcement, which
   * is where it started, means a model that overshoots twice simply ships a
   * four-page "1-2 page" summary.
   *
   * So the backstop cuts at a **section boundary** instead: whole
   * heading-delimited sections are dropped from the end, never part of one.
   * That respects the structure the artifact is defined by, and it is
   * deterministic in a way "ask the model again" is not.
   */
  describe("the Executive Summary's size backstop", () => {
    /** `## heading` plus a body of `wordCount` words, as its own section. */
    function section(heading: string, wordCount: number): string {
      return `## ${heading}\n\n${words(wordCount)}`;
    }

    it('drops whole trailing sections from an over-long Executive Summary', async () => {
      const seeded = await seedConvertedVersion(
        'sprawling-summary.md',
        `# Sprawl\n\n${body('sprawl')}\n`,
      );

      // 1400 words over seven 200-word sections, well past the 1000-word
      // ceiling. Dropping the last two lands on 1000; dropping more would be
      // unnecessary. A table and a bullet list sit in sections that must
      // survive intact — the whole point of cutting at a section boundary.
      const overlongSummary = [
        section('Purpose', 200),
        '## Findings\n\n- Revenue grew to 12.4M.\n- Supply-chain risk remains.\n- Headcount is flat.',
        '## Figures\n\n| Quarter | Total |\n| --- | --- |\n| Q1 | 12.4M |\n| Q2 | 18.9M |',
        section('Obligations', 200),
        section('Risks', 200),
        section('Appendix A', 200),
        section('Appendix B', 200),
      ].join('\n\n');

      const { calls, fetchStub } = stubOpenRouter((call) => {
        switch (call.task) {
          case 'metadata':
            return '{"title":"Sprawl","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
          case 'sectionSummary':
            return 'A section summary.';
          case 'chatSnippet':
            return words(200);
          case 'abstract':
            return words(80);
          case 'executiveSummary':
            // Both the first answer and the corrective rewrite overshoot,
            // which is what actually happens.
            return overlongSummary;
          default:
            throw new Error(`Unexpected task ${call.task}`);
        }
      });

      await runSummarizeDocumentJob(depsWith(fetchStub), {
        payload: { documentId: seeded.documentId, versionId: seeded.versionId },
        willRetry: false,
      });

      // The model got its corrective chance first; the trim is the last
      // resort, exactly as for the Abstract.
      expect(calls.filter((c) => c.task === 'executiveSummary')).toHaveLength(2);

      const version = await readVersion(seeded.versionId);
      const summary = (version.executive_summary ?? '').trim();
      const count = summary.split(/\s+/).length;
      expect(count).toBeLessThanOrEqual(1000);
      expect(count).toBeGreaterThanOrEqual(500);

      // Cut between sections. The earliest sections survive whole — table
      // rows and bullets included — and the trailing ones are gone outright
      // rather than half-present.
      expect(summary).toContain('## Purpose');
      expect(summary).toContain('| Q2 | 18.9M |');
      expect(summary).toContain('- Headcount is flat.');
      expect(summary).not.toContain('Appendix B');

      // And nothing ends on a heading introducing content that was dropped.
      const lines = summary.split('\n').filter((line) => line.trim() !== '');
      expect(lines[lines.length - 1].startsWith('#')).toBe(false);
    });

    it('stores an un-trimmable Executive Summary but records that it is out of range', async () => {
      const seeded = await seedConvertedVersion(
        'unbroken-summary.md',
        `# Unbroken\n\n${body('unbroken')}\n`,
      );

      // 1500 words in one unbroken block: no heading, no list, no table, so
      // there is no boundary to cut at that would not land mid-prose. The
      // artifact is still worth far more to a reader than a Document stuck
      // in `failed`, so it ships — but silently shipping a 1500-word "1-2
      // page" summary is how a size guarantee quietly stops being one, so
      // the out-of-range result is written down where an operator can find
      // it.
      const unbrokenSummary = words(1500);

      const { fetchStub } = stubOpenRouter((call) => {
        switch (call.task) {
          case 'metadata':
            return '{"title":"Unbroken","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
          case 'sectionSummary':
            return 'A section summary.';
          case 'chatSnippet':
            return words(200);
          case 'abstract':
            return words(80);
          case 'executiveSummary':
            return unbrokenSummary;
          default:
            throw new Error(`Unexpected task ${call.task}`);
        }
      });

      await runSummarizeDocumentJob(depsWith(fetchStub), {
        payload: { documentId: seeded.documentId, versionId: seeded.versionId },
        willRetry: false,
      });

      const version = await readVersion(seeded.versionId);
      // The stage succeeded and the artifact was kept whole.
      expect(version.ingestion_status).toBe('summarized');
      expect((version.executive_summary ?? '').trim().split(/\s+/)).toHaveLength(1500);
      expect(version.ingestion_error).toBeNull();

      // But it is on the record, naming the artifact, what it measured and
      // what was required.
      const warnings = version.artifact_warnings as Array<{
        artifact: string;
        words: number;
        minWords: number;
        maxWords: number;
      }> | null;
      expect(warnings).not.toBeNull();
      expect(warnings).toEqual([
        { artifact: 'executiveSummary', words: 1500, minWords: 500, maxWords: 1000 },
      ]);
    });

    it('records no warning when every artifact landed in range', async () => {
      const seeded = await seedConvertedVersion('tidy-summary.md', `# Tidy\n\n${body('tidy')}\n`);

      const { fetchStub } = stubOpenRouter((call) => {
        switch (call.task) {
          case 'metadata':
            return '{"title":"Tidy","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
          case 'sectionSummary':
            return 'A section summary.';
          case 'chatSnippet':
            return words(200);
          case 'abstract':
            return words(80);
          case 'executiveSummary':
            return words(700);
          default:
            throw new Error(`Unexpected task ${call.task}`);
        }
      });

      await runSummarizeDocumentJob(depsWith(fetchStub), {
        payload: { documentId: seeded.documentId, versionId: seeded.versionId },
        willRetry: false,
      });

      const version = await readVersion(seeded.versionId);
      expect(version.artifact_warnings).toBeNull();
    });
  });

  // Per ADR-0004 and GLOSSARY.md, Ingestion is "a chain of independently
  // retryable Stages, each one enqueuing the next on success". Stage 2 is
  // now in the middle of that chain, so it has to hand over to stage 3
  // (chunking and embeddings, NBK-8) exactly the way stage 1 hands over to
  // it.
  it('enqueues ingestion stage 3 once the summaries are stored, and not when it fails', async () => {
    const enqueued: { documentId: string; versionId: string }[] = [];
    const enqueueEmbedChunks = async (payload: { documentId: string; versionId: string }) => {
      enqueued.push(payload);
    };

    const succeeded = await seedConvertedVersion(
      'chained.md',
      `# Chained\n\n${body('chaining')}\n`,
    );
    const { fetchStub } = stubOpenRouter((call) => {
      switch (call.task) {
        case 'metadata':
          return '{"title":"Chained","authors":[],"documentType":"note","language":"en","publishedOn":null,"keywords":[]}';
        case 'sectionSummary':
          return 'A section summary.';
        case 'chatSnippet':
          return words(200);
        case 'executiveSummary':
          return words(700);
        default:
          return words(70);
      }
    });

    await runSummarizeDocumentJob(
      { ...depsWith(fetchStub), enqueueEmbedChunks },
      {
        payload: { documentId: succeeded.documentId, versionId: succeeded.versionId },
        willRetry: false,
      },
    );

    expect(enqueued).toEqual([
      { documentId: succeeded.documentId, versionId: succeeded.versionId },
    ]);

    // A failed stage 2 leaves no summaries, so handing over would only queue
    // a stage-3 job for a Version the pipeline hasn't finished with.
    const failed = await seedConvertedVersion(
      'unchained.md',
      '# Unchained\n\nNot going anywhere.\n',
    );
    const failingFetch: typeof globalThis.fetch = async () => {
      throw new Error('socket hang up');
    };
    await expect(
      runSummarizeDocumentJob(
        {
          pool,
          complete: createOpenRouterCompleter({ apiKey: 'k', fetch: failingFetch, retries: 0 }),
          enqueueEmbedChunks,
        },
        {
          payload: { documentId: failed.documentId, versionId: failed.versionId },
          willRetry: false,
        },
      ),
    ).rejects.toThrow('socket hang up');

    expect(enqueued).toHaveLength(1);
  });

  it("marks the Version failed and keeps the Converted Markdown when summarization can't be retried", async () => {
    const seeded = await seedConvertedVersion('doomed.md', '# Doomed\n\nStill here afterwards.\n');

    const failingFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });

    await expect(
      runSummarizeDocumentJob(
        {
          pool,
          complete: createOpenRouterCompleter({ apiKey: 'k', fetch: failingFetch, retries: 0 }),
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: false,
        },
      ),
    ).rejects.toThrow(/429/);

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('failed');
    expect(version.ingestion_error).toContain('429');
    // Stage 2's input survives its failure, so a retry has something to
    // work from and stage 1 never has to run again.
    expect(version.markdown).toContain('Still here afterwards.');
    expect(version.abstract).toBeNull();
    expect(version.summarized_at).toBeNull();

    const events = await waitForEvents((all) =>
      all.some(
        (e) =>
          (e.data as { versionId?: string }).versionId === seeded.versionId &&
          (e.data as { status?: string }).status === 'failed',
      ),
    );
    const mine = events.filter(
      (e) => (e.data as { versionId?: string }).versionId === seeded.versionId,
    );
    expect(mine.map((e) => (e.data as { status?: string }).status)).toEqual([
      'summarizing',
      'failed',
    ]);
  });

  it("returns the Version to 'converted' when the failure will be retried", async () => {
    const seeded = await seedConvertedVersion('flaky.md', '# Flaky\n\nRetry me.\n');

    const failingFetch: typeof globalThis.fetch = async () => {
      throw new Error('socket hang up');
    };

    await expect(
      runSummarizeDocumentJob(
        {
          pool,
          complete: createOpenRouterCompleter({ apiKey: 'k', fetch: failingFetch, retries: 0 }),
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: true,
        },
      ),
    ).rejects.toThrow('socket hang up');

    const version = await readVersion(seeded.versionId);
    // Back to the status stage 2 *consumes*, not to "queued" (which would
    // claim the conversion is owed again) and not to "failed" (which would
    // claim a retry isn't coming).
    expect(version.ingestion_status).toBe('converted');
    expect(version.ingestion_error).toContain('socket hang up');
  });

  /**
   * NBK-1's operator story, applied where it actually costs money: "a
   * transient failure in one stage (e.g. a rate-limited OpenRouter call)
   * doesn't force the whole pipeline to restart".
   *
   * Stage 2 is one job that makes 1 metadata call, one call *per section*,
   * and 3 reduction calls. On a 200-page document the map pass is dozens of
   * calls and essentially the whole bill (measured: ~$0.05 and 5-8 minutes,
   * see docs/ingestion-summaries.md), so a rate-limited *reduction* — the
   * last three calls — re-paying for every section summary is the expensive
   * shape of exactly the problem that story describes.
   *
   * The fix is not more queues (see ADR-0006) but making the map pass
   * resumable: each section summary is persisted as it completes, and a
   * retry reuses the ones already done.
   */
  describe('a retry does not re-pay for section summaries already done', () => {
    /** A document with `count` sections, each long enough to be summarized. */
    function multiSectionMarkdown(count: number): string {
      return [
        '# Annual Report',
        ...Array.from(
          { length: count },
          (_, i) => `## Section ${i + 1}\n\n${body(`section-${i + 1}`)}`,
        ),
      ].join('\n\n');
    }

    it('re-uses persisted section summaries and only re-runs the reduce pass', async () => {
      const seeded = await seedConvertedVersion('expensive.md', multiSectionMarkdown(6));

      // Attempt 1: every section summary succeeds, then the first reduction
      // (the Chat Snippet) fails — the rate-limit shape the story names.
      let failReductions = true;
      const first = stubOpenRouter((call) => {
        if (call.task === 'metadata') {
          return '{"title":"Annual Report","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
        }
        if (call.task === 'sectionSummary') return `Summary of ${call.user.slice(0, 40)}`;
        if (failReductions) throw new Error('429 rate limited');
        throw new Error(`Unexpected task ${call.task}`);
      });

      await expect(
        runSummarizeDocumentJob(depsWith(first.fetchStub), {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: true,
        }),
      ).rejects.toThrow();

      expect(first.calls.filter((c) => c.task === 'sectionSummary')).toHaveLength(6);
      // The work that succeeded is on the record, not thrown away with the
      // attempt that failed.
      const afterFailure = await readVersion(seeded.versionId);
      expect(afterFailure.ingestion_status).toBe('converted');
      expect(afterFailure.section_summaries).not.toBeNull();

      // Attempt 2: the retry, with nothing failing this time.
      failReductions = false;
      const second = stubOpenRouter((call) => {
        switch (call.task) {
          case 'metadata':
            return '{"title":"Annual Report","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
          case 'sectionSummary':
            return 'A section summary nobody should have had to pay for twice.';
          case 'chatSnippet':
            return words(200);
          case 'executiveSummary':
            return words(700);
          case 'abstract':
            return words(80);
          default:
            throw new Error(`Unexpected task ${call.task}`);
        }
      });

      await runSummarizeDocumentJob(depsWith(second.fetchStub), {
        payload: { documentId: seeded.documentId, versionId: seeded.versionId },
        willRetry: true,
      });

      // The point of the whole exercise: the six map calls are not re-made.
      expect(second.calls.filter((c) => c.task === 'sectionSummary')).toHaveLength(0);
      // And the reductions, which is what actually failed, do run again —
      // against the summaries attempt 1 produced.
      expect(second.calls.filter((c) => c.task === 'chatSnippet')).toHaveLength(1);
      const reduce = second.calls.find((c) => c.task === 'executiveSummary')!;
      expect(reduce.user).toContain('Summary of');
      expect(reduce.user).not.toContain('nobody should have had to pay for twice');

      const version = await readVersion(seeded.versionId);
      expect(version.ingestion_status).toBe('summarized');
      // The scratch area is cleared once its summaries have been reduced
      // into the three artifacts: it is work-in-progress, not an artifact,
      // and a 200-page document's worth of it should not sit on every
      // finished Version forever.
      expect(version.section_summaries).toBeNull();
    });

    it('re-summarizes from scratch when the Converted Markdown has changed under it', async () => {
      const seeded = await seedConvertedVersion('rewritten.md', multiSectionMarkdown(3));

      let failReductions = true;
      const first = stubOpenRouter((call) => {
        if (call.task === 'metadata') {
          return '{"title":"Annual Report","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
        }
        if (call.task === 'sectionSummary') return 'A summary of the old text.';
        if (failReductions) throw new Error('429 rate limited');
        throw new Error(`Unexpected task ${call.task}`);
      });

      await expect(
        runSummarizeDocumentJob(depsWith(first.fetchStub), {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: true,
        }),
      ).rejects.toThrow();
      expect(first.calls.filter((c) => c.task === 'sectionSummary')).toHaveLength(3);

      // Stage 1 re-ran against the same Version and produced different
      // Markdown. The cached summaries describe text that is no longer
      // there, so reusing them would reduce a document nobody uploaded.
      await pool.query('UPDATE document_versions SET markdown = $2 WHERE id = $1', [
        seeded.versionId,
        multiSectionMarkdown(4),
      ]);

      failReductions = false;
      const second = stubOpenRouter((call) => {
        switch (call.task) {
          case 'metadata':
            return '{"title":"Annual Report","authors":[],"documentType":"report","language":"en","publishedOn":null,"keywords":[]}';
          case 'sectionSummary':
            return 'A summary of the new text.';
          case 'chatSnippet':
            return words(200);
          case 'executiveSummary':
            return words(700);
          case 'abstract':
            return words(80);
          default:
            throw new Error(`Unexpected task ${call.task}`);
        }
      });

      await runSummarizeDocumentJob(depsWith(second.fetchStub), {
        payload: { documentId: seeded.documentId, versionId: seeded.versionId },
        willRetry: true,
      });

      expect(second.calls.filter((c) => c.task === 'sectionSummary')).toHaveLength(4);
      const reduce = second.calls.find((c) => c.task === 'executiveSummary')!;
      expect(reduce.user).toContain('A summary of the new text.');
      expect(reduce.user).not.toContain('A summary of the old text.');
    });
  });

  // NBK-64: missing input is an internal inconsistency, nothing a user can fix
  // by changing their file, so it is reported as the honest fallback.
  it("records 'unexpected' when the Converted Markdown is missing and no retry is left", async () => {
    const seeded = await seedConvertedVersion('hollow.md', '   ');
    const neverCalled: typeof globalThis.fetch = async () => {
      throw new Error('should never be called');
    };

    await expect(
      runSummarizeDocumentJob(
        { pool, complete: createOpenRouterCompleter({ apiKey: 'k', fetch: neverCalled }) },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: false,
        },
      ),
    ).rejects.toThrow(/no Converted Markdown/);

    const [document] = await listDocuments(pool, seeded.notebookId);
    expect(document.status).toBe('failed');
    expect(document.failure).toEqual({ reason: 'unexpected', failedAt: 'summarizing' });
  });

  it('does nothing for a Document Version that no longer exists', async () => {
    const neverCalled: typeof globalThis.fetch = async () => {
      throw new Error('should never be called');
    };
    await expect(
      runSummarizeDocumentJob(
        { pool, complete: createOpenRouterCompleter({ apiKey: 'k', fetch: neverCalled }) },
        {
          payload: {
            documentId: '00000000-0000-0000-0000-000000000000',
            versionId: '00000000-0000-0000-0000-000000000001',
          },
          willRetry: true,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_METADATA_KEYWORDS,
  extractMetadata,
  type GenerationDeps,
} from '../src/ingestion/generated-artifacts.js';
import type { ChatCompleter } from '../src/llm/openrouter.js';
import type { TaskModels } from '../src/llm/models.js';

const models: TaskModels = {
  metadata: 'test/metadata',
  sectionSummary: 'test/section',
  chatSnippet: 'test/snippet',
  executiveSummary: 'test/executive',
  abstract: 'test/abstract',
  chatAnswer: 'test/answer',
};

/**
 * Stage 2's metadata extraction against a stub completer, with no database
 * and no OpenRouter: what the model answers is the whole input here.
 */
function depsAnswering(answer: string): GenerationDeps & { prompts: string[] } {
  const prompts: string[] = [];
  const complete: ChatCompleter = async ({ system }) => {
    prompts.push(system);
    return answer;
  };
  return { complete, models, prompts };
}

const input = { filename: 'novel.pdf', markdown: '# Chapter One\n\nIt begins.', sections: [] };

describe('metadata extraction (NBK-24)', () => {
  it('says the answer was cut off when the JSON object never closes', async () => {
    // What one model did for a 31-Document batch: listed keywords until its
    // 800-token output limit cut the answer mid-array. The old message said
    // "expected a JSON object", which sent the investigation after a
    // non-JSON answer.
    const truncated =
      '{"title": "La Cagliostro se venge", "authors": [], "documentType": "novel", ' +
      '"language": "fr", "publishedOn": null, "subject": "fiction", "keywords": ["novel", "fiction", ';
    await expect(extractMetadata(depsAnswering(truncated), input)).rejects.toThrow(
      /cut off before the JSON object closed/,
    );
  });

  it('still rejects an answer with no JSON object in it at all', async () => {
    await expect(
      extractMetadata(depsAnswering('I cannot determine the metadata.'), input),
    ).rejects.toThrow(/Expected a JSON object/);
  });

  it('asks for a bounded keyword list and caps whatever comes back anyway', async () => {
    const tooMany = Array.from({ length: 40 }, (_, i) => `keyword ${i}`);
    const deps = depsAnswering(
      JSON.stringify({ title: 'Sprawl', authors: [], keywords: tooMany, language: 'en' }),
    );

    const metadata = await extractMetadata(deps, input);

    expect(deps.prompts[0]).toContain(`at most ${MAX_METADATA_KEYWORDS} short phrases`);
    expect(metadata.keywords).toHaveLength(MAX_METADATA_KEYWORDS);
    expect(metadata.keywords[0]).toBe('keyword 0');
    expect(metadata.title).toBe('Sprawl');
  });
});

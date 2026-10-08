import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { render } from '@testing-library/angular';
import { DocumentDetailPage } from './document-detail-page';
import { DocumentsService } from '../api/services/documents.service';
import { provideAppIcons } from '../shared/fluent-icons';

// Shared by the Document page's area specs (CODING_STANDARDS.md, "Test
// helpers in a seam-3 spec").

export const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
export const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
export const VERSION_ID = '33333333-3333-3333-3333-333333333333';

// A Citation opens this page with the Document Version it pinned, the chunk
// it points at and that chunk's character range in the Converted Markdown —
// see `ThreadView.citationParams`.
export function activatedRoute(queryParams: Record<string, string> = {}) {
  return {
    provide: ActivatedRoute,
    useValue: {
      snapshot: {
        paramMap: convertToParamMap({ notebookId: NOTEBOOK_ID, documentId: DOCUMENT_ID }),
        queryParamMap: convertToParamMap(queryParams),
      },
    },
  };
}

export const SUMMARIZED_DETAIL = {
  id: DOCUMENT_ID,
  notebookId: NOTEBOOK_ID,
  filename: 'quarterly.pdf',
  status: 'summarized',
  abstract: 'A short Abstract for lists.',
  chatSnippet: 'A dense Chat Snippet for the model.',
  executiveSummary:
    '## Key points\n\n- Revenue grew 18% year on year.\n- Supply-chain risk remains the main exposure.\n',
  metadata: { title: 'Quarterly Report 2025', authors: ['A. Analyst'], documentType: 'report' },
  createdAt: '2026-01-01T00:00:00.000Z',
  latestVersion: {
    id: VERSION_ID,
    versionNumber: 2,
    mimeType: 'application/pdf',
    sizeBytes: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

export const FULL_MARKDOWN = [
  '# Quarterly Report 2025',
  '',
  '## Revenue',
  '',
  'Revenue grew to 12.4M.',
  '',
  '| Quarter | Total |',
  '| --- | --- |',
  '| Q1 | 12.4M |',
  '',
].join('\n');

/**
 * Renders the real page and its root store, with only the generated client
 * (`DocumentsService`) stubbed: the seam every Document page spec tests at.
 */
export function renderPage(
  documentsService: Partial<DocumentsService>,
  route: ReturnType<typeof activatedRoute> = activatedRoute(),
) {
  return render(DocumentDetailPage, {
    providers: [
      provideAppIcons(),
      route,
      { provide: DocumentsService, useValue: documentsService },
    ],
  });
}

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiConfiguration } from '../api/api-configuration';
import { BaseService } from '../api/base-service';
import type { Document } from './documents.store';

/**
 * Handles the two Document operations (NBK-5) the generated ng-openapi-gen
 * client can't: sending a `multipart/form-data` upload body, and reading
 * back an arbitrary binary download. The backend's upload and download
 * routes (apps/backend/src/documents/routes.ts) deliberately don't declare
 * Zod body/response schemas for these — a raw file upload and "whatever
 * bytes were stored" don't fit Zod's JSON-shaped validation model — so
 * ng-openapi-gen has nothing to generate a usable method from (see
 * src/app/api/fn/documents/upload-document.ts and
 * download-document-version.ts: no request body is ever sent, and the
 * response body is discarded). This is the documented, narrow escape hatch
 * for just those two calls; `DocumentsService` (generated) still covers
 * list/delete/restore. It extends the same `BaseService` the generated
 * services do, so it shares `rootUrl` resolution and goes through the same
 * `withCredentialsInterceptor`.
 */
@Injectable({ providedIn: 'root' })
export class DocumentTransferService extends BaseService {
  constructor(config: ApiConfiguration, http: HttpClient) {
    super(config, http);
  }

  /**
   * Uploads `file` into a Notebook. Per NBK-5, the backend creates a new
   * Document, or a new Version of an existing one if the filename already
   * exists (undeleted) in the Notebook.
   */
  uploadDocument(notebookId: string, file: File): Promise<Document> {
    const formData = new FormData();
    formData.set('file', file, file.name);
    return firstValueFrom(
      this.http.post<Document>(`${this.rootUrl}/notebooks/${notebookId}/documents`, formData),
    );
  }

  /**
   * Downloads the exact original bytes of a Document Version and hands them
   * to the browser's normal "save this file" flow under `filename`.
   */
  async downloadDocumentVersion(
    notebookId: string,
    documentId: string,
    versionId: string,
    filename: string,
  ): Promise<void> {
    const blob = await firstValueFrom(
      this.http.get(
        `${this.rootUrl}/notebooks/${notebookId}/documents/${documentId}/versions/${versionId}/download`,
        { responseType: 'blob' },
      ),
    );
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

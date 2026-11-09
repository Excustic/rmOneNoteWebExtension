/**
 * Microsoft Graph OneNote API types and request/response contracts.
 *
 * Ported from `rmOneNoteSync/app/rmOneNoteSyncApp/Services/OneNoteClient.cs`.
 */

export const ONENOTE_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0/me/onenote';

export interface OneNoteUrl {
  readonly href?: string | null;
}

export interface OneNoteLinks {
  readonly oneNoteClientUrl?: OneNoteUrl | null;
  readonly oneNoteWebUrl?: OneNoteUrl | null;
}

export interface OneNoteSection {
  readonly id: string;
  readonly displayName: string;
  readonly createdDateTime?: string;
  readonly lastModifiedDateTime?: string;
  readonly links?: OneNoteLinks | null;
}

export interface OneNoteNotebook {
  readonly id: string;
  readonly displayName: string;
  readonly createdDateTime?: string;
  readonly lastModifiedDateTime?: string;
  readonly self?: string | null;
  readonly links?: OneNoteLinks | null;
  readonly sections?: readonly OneNoteSection[] | null;
}

export interface OneNotePage {
  readonly id: string;
  readonly title: string;
  readonly createdDateTime?: string;
  readonly lastModifiedDateTime?: string;
  readonly contentUrl?: string | null;
  readonly links?: OneNoteLinks | null;
}

export interface ODataCollectionResponse<T> {
  readonly value?: readonly T[] | null;
}

export interface OneNoteTargetPath {
  readonly notebookName: string;
  readonly sectionName: string;
  readonly pageTitle: string;
}

export interface UploadInkMlPageParams {
  readonly sectionId: string;
  readonly title: string;
  readonly inkmlXml: string | Uint8Array;
  readonly presentationHtml: string | Uint8Array;
  readonly backgroundPdfBytes?: Uint8Array | null;
}

export interface UpdateInkMlPageParams {
  readonly pageId: string;
  readonly title: string;
  readonly inkmlXml: string | Uint8Array;
  readonly presentationHtml: string | Uint8Array;
  readonly backgroundPdfBytes?: Uint8Array | null;
}

export interface VerifiedOneNotePageResult {
  readonly page: OneNotePage;
  readonly oneNoteUrl: string;
}

export interface ResolvedOneNoteTarget {
  readonly notebookId: string;
  readonly notebookDisplayName: string;
  readonly notebookWebUrl: string | null;
  readonly sectionId: string;
  readonly sectionDisplayName: string;
}


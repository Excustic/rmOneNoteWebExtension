import Dexie, { type EntityTable, type Table } from 'dexie';
import type { DocumentRecord, NotebookCacheRecord, PageRecord } from './models';

export class RmOneNoteDatabase extends Dexie {
  documents!: EntityTable<DocumentRecord, 'documentId'>;
  pages!: Table<PageRecord, [string, string]>;
  notebooks!: EntityTable<NotebookCacheRecord, 'oneNoteNotebookId'>;

  constructor(databaseName = 'rmOneNoteSyncDb') {
    super(databaseName);

    this.version(1).stores({
      documents: 'documentId, parent, type, lastModified',
      pages: '[documentId+pageId], documentId, status, lastModified, lastSyncTime',
      notebooks: 'oneNoteNotebookId, &displayName, updatedAt',
    });
  }
}

export const db = new RmOneNoteDatabase();

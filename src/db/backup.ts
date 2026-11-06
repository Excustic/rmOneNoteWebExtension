import { db, type RmOneNoteDatabase } from './db';
import {
  DATABASE_BACKUP_SCHEMA_VERSION,
  type DatabaseBackupPayload,
  type DocumentRecord,
  type NotebookCacheRecord,
  type PageRecord,
} from './models';

export interface ImportBackupSummary {
  documentsImported: number;
  pagesImported: number;
  notebooksImported: number;
}

/**
 * Exports all local IndexedDB tables (`documents`, `pages`, `notebooks`) into a portable
 * snapshot object so a user can seed a newly installed browser when `storage.sync` has
 * evicted older page records.
 */
export async function exportDatabaseBackup(
  database: RmOneNoteDatabase = db,
): Promise<DatabaseBackupPayload> {
  return database.transaction(
    'r',
    [database.documents, database.pages, database.notebooks],
    async () => {
      const [documents, pages, notebooks] = await Promise.all([
        database.documents.toArray(),
        database.pages.toArray(),
        database.notebooks.toArray(),
      ]);

      return {
        schemaVersion: DATABASE_BACKUP_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        documents,
        pages,
        notebooks,
      };
    },
  );
}

export async function serializeDatabaseBackup(
  database: RmOneNoteDatabase = db,
): Promise<string> {
  const payload = await exportDatabaseBackup(database);
  return JSON.stringify(payload, null, 2);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBackupPayload(parsed: unknown): DatabaseBackupPayload {
  if (!isObjectRecord(parsed)) {
    throw new Error('Invalid backup file: root value must be a JSON object.');
  }

  if (parsed.schemaVersion !== DATABASE_BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported backup schema version "${String(parsed.schemaVersion)}". Expected version ${DATABASE_BACKUP_SCHEMA_VERSION}.`,
    );
  }

  if (
    !Array.isArray(parsed.documents) ||
    !Array.isArray(parsed.pages) ||
    !Array.isArray(parsed.notebooks)
  ) {
    throw new Error(
      'Invalid backup file: expected "documents", "pages", and "notebooks" arrays.',
    );
  }

  for (const doc of parsed.documents) {
    if (!isObjectRecord(doc) || typeof doc.documentId !== 'string' || !doc.documentId) {
      throw new Error('Invalid backup file: malformed document record.');
    }
  }

  for (const page of parsed.pages) {
    if (
      !isObjectRecord(page) ||
      typeof page.documentId !== 'string' ||
      typeof page.pageId !== 'string' ||
      !page.documentId ||
      !page.pageId
    ) {
      throw new Error('Invalid backup file: malformed page record.');
    }
  }

  for (const nb of parsed.notebooks) {
    if (
      !isObjectRecord(nb) ||
      typeof nb.oneNoteNotebookId !== 'string' ||
      !nb.oneNoteNotebookId
    ) {
      throw new Error('Invalid backup file: malformed notebook cache record.');
    }
  }

  return parsed as unknown as DatabaseBackupPayload;
}

/**
 * Atomically merges an exported JSON backup into local IndexedDB without overwriting newer
 * sync timestamps that the current browser already recorded from `storage.sync`.
 */
export async function importDatabaseBackupJson(
  rawJson: string,
  database: RmOneNoteDatabase = db,
): Promise<ImportBackupSummary> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid backup file: failed to parse JSON.');
  }

  const backup = validateBackupPayload(parsed);

  await database.transaction(
    'rw',
    [database.documents, database.pages, database.notebooks],
    async () => {
      if (backup.documents.length > 0) {
        const existingDocs = await database.documents.bulkGet(
          backup.documents.map((d) => d.documentId),
        );
        const mergedDocs: DocumentRecord[] = backup.documents.map((incoming, idx) => {
          const existing = existingDocs[idx];
          if (!existing) {
            return incoming;
          }
          return existing.lastModified > incoming.lastModified
            ? {
                ...existing,
                oneNoteNotebookUrl: existing.oneNoteNotebookUrl ?? incoming.oneNoteNotebookUrl,
              }
            : {
                ...incoming,
                oneNoteNotebookUrl: incoming.oneNoteNotebookUrl ?? existing.oneNoteNotebookUrl,
              };
        });
        await database.documents.bulkPut(mergedDocs);
      }

      if (backup.pages.length > 0) {
        const existingPages = await database.pages.bulkGet(
          backup.pages.map((p): [string, string] => [p.documentId, p.pageId]),
        );
        const mergedPages: PageRecord[] = backup.pages.map((incoming, idx) => {
          const existing = existingPages[idx];
          if (!existing) {
            return incoming;
          }

          const existingSync = existing.lastSyncTime ?? '';
          const incomingSync = incoming.lastSyncTime ?? '';
          if (existingSync > incomingSync) {
            return {
              ...incoming,
              ...existing,
              oneNotePageId: existing.oneNotePageId ?? incoming.oneNotePageId,
              oneNotePageUrl: existing.oneNotePageUrl ?? incoming.oneNotePageUrl,
            };
          }

          return {
            ...existing,
            ...incoming,
            oneNotePageId: incoming.oneNotePageId ?? existing.oneNotePageId,
            oneNotePageUrl: incoming.oneNotePageUrl ?? existing.oneNotePageUrl,
          };
        });
        await database.pages.bulkPut(mergedPages);
      }

      if (backup.notebooks.length > 0) {
        const existingNotebooks = await database.notebooks.bulkGet(
          backup.notebooks.map((n) => n.oneNoteNotebookId),
        );
        const mergedNotebooks: NotebookCacheRecord[] = backup.notebooks.map((incoming, idx) => {
          const existing = existingNotebooks[idx];
          if (!existing) {
            return incoming;
          }
          return {
            ...(existing.updatedAt > incoming.updatedAt ? existing : incoming),
            sections: {
              ...incoming.sections,
              ...existing.sections,
            },
          };
        });
        await database.notebooks.bulkPut(mergedNotebooks);
      }
    },
  );

  return {
    documentsImported: backup.documents.length,
    pagesImported: backup.pages.length,
    notebooksImported: backup.notebooks.length,
  };
}


/**
 * Persistent OneNote Notebook and Section hierarchy resolver backed by `Dexie.notebooks`
 * and per-key async mutex locks (`KeyedMutex`).
 *
 * Prevents duplicate notebook/section creation when concurrent page workers sync
 * pages belonging to the same folder or document.
 */

import { db, type RmOneNoteDatabase } from '../db/db';
import type { NotebookCacheRecord, OneNoteSectionCacheEntry } from '../db/models';
import {
  getCachedNotebookByName,
  upsertCachedNotebook,
  upsertCachedSection,
} from '../db/repository';
import { type OneNoteClient, resolveOneNoteLinkUrl } from './oneNoteClient';
import { KeyedMutex } from './throttle';
import type { OneNoteNotebook, ResolvedOneNoteTarget } from './types';

function mapSectionsToRecord(
  notebook: OneNoteNotebook
): Record<string, OneNoteSectionCacheEntry> {
  const map: Record<string, OneNoteSectionCacheEntry> = {};
  if (!notebook.sections) {
    return map;
  }
  for (const sec of notebook.sections) {
    if (sec.id && sec.displayName) {
      map[sec.displayName] = {
        sectionId: sec.id,
        displayName: sec.displayName,
      };
    }
  }
  return map;
}

export class OneNoteDirectoryCache {
  private readonly client: OneNoteClient;
  private readonly database: RmOneNoteDatabase;
  private readonly notebookLocks = new KeyedMutex();
  private readonly sectionLocks = new KeyedMutex();

  constructor(client: OneNoteClient, database: RmOneNoteDatabase = db) {
    this.client = client;
    this.database = database;
  }

  /**
   * Fetches all OneNote notebooks (`$expand=sections`) from Microsoft Graph and
   * persists them into `Dexie.notebooks`.
   */
  async primeFromGraph(): Promise<NotebookCacheRecord[]> {
    const notebooks = await this.client.listNotebooks();
    const saved: NotebookCacheRecord[] = [];

    for (const nb of notebooks) {
      if (!nb.id || !nb.displayName) {
        continue;
      }
      const record = await upsertCachedNotebook(
        {
          oneNoteNotebookId: nb.id,
          displayName: nb.displayName,
          webUrl: resolveOneNoteLinkUrl(nb.links),
          sections: mapSectionsToRecord(nb),
        },
        this.database
      );
      saved.push(record);
    }

    return saved;
  }

  /**
   * Resolves (or creates) the target OneNote notebook and section for a given
   * sanitized `{ notebookName, sectionName }`, using `Dexie.notebooks` and keyed locks.
   */
  async resolveTargetNotebookAndSection(
    notebookName: string,
    sectionName: string
  ): Promise<ResolvedOneNoteTarget> {
    const resolvedNotebook = await this.notebookLocks.runExclusive(
      notebookName,
      async (): Promise<NotebookCacheRecord> => {
        const cached = await getCachedNotebookByName(notebookName, this.database);
        if (cached) {
          return cached;
        }

        // Refresh local cache from Graph before creating a new notebook
        await this.primeFromGraph();
        const afterRefresh = await getCachedNotebookByName(notebookName, this.database);
        if (afterRefresh) {
          return afterRefresh;
        }

        const created = await this.client.createNotebook(notebookName);
        return upsertCachedNotebook(
          {
            oneNoteNotebookId: created.id,
            displayName: created.displayName || notebookName,
            webUrl: resolveOneNoteLinkUrl(created.links),
            sections: mapSectionsToRecord(created),
          },
          this.database
        );
      }
    );

    const sectionLockKey = `${resolvedNotebook.oneNoteNotebookId}|${sectionName}`;
    const resolvedSection = await this.sectionLocks.runExclusive(
      sectionLockKey,
      async (): Promise<OneNoteSectionCacheEntry> => {
        const latestNb =
          (await getCachedNotebookByName(notebookName, this.database)) ?? resolvedNotebook;
        const cachedSection = latestNb.sections[sectionName];
        if (cachedSection) {
          return cachedSection;
        }

        // Query current sections for this notebook before creating
        const cloudSections = await this.client.listSections(
          resolvedNotebook.oneNoteNotebookId
        );
        const sectionMap: Record<string, OneNoteSectionCacheEntry> = {};
        for (const sec of cloudSections) {
          if (sec.id && sec.displayName) {
            sectionMap[sec.displayName] = {
              sectionId: sec.id,
              displayName: sec.displayName,
            };
          }
        }

        if (Object.keys(sectionMap).length > 0) {
          await upsertCachedNotebook(
            {
              oneNoteNotebookId: resolvedNotebook.oneNoteNotebookId,
              displayName: resolvedNotebook.displayName,
              webUrl: resolvedNotebook.webUrl,
              sections: sectionMap,
            },
            this.database
          );
        }

        const foundAfterList = sectionMap[sectionName];
        if (foundAfterList) {
          return foundAfterList;
        }

        const createdSec = await this.client.createSection(
          resolvedNotebook.oneNoteNotebookId,
          sectionName
        );
        const entry: OneNoteSectionCacheEntry = {
          sectionId: createdSec.id,
          displayName: createdSec.displayName || sectionName,
        };
        await upsertCachedSection(
          resolvedNotebook.oneNoteNotebookId,
          entry,
          this.database
        );
        return entry;
      }
    );

    return {
      notebookId: resolvedNotebook.oneNoteNotebookId,
      notebookDisplayName: resolvedNotebook.displayName,
      notebookWebUrl: resolvedNotebook.webUrl,
      sectionId: resolvedSection.sectionId,
      sectionDisplayName: resolvedSection.displayName,
    };
  }
}

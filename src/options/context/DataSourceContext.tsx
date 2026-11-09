import React, { createContext, useContext } from 'react';
import { type AuthStatusSummary, getAuthStatusSummary } from '../../auth/authStore';
import { db as realDb, type RmOneNoteDatabase } from '../../db/db';
import type { DocumentRecord } from '../../db/models';
import { getAllDocuments } from '../../db/repository';
import { saveWhitelistAndReconcilePages } from '../../remarkable/treeSync';
import type { SaveWhitelistSelectionResult } from '../../remarkable/types';
import { ext } from '../../shared/browser';
import type { RuntimeRequest, RuntimeResponse } from '../../shared/messaging';
import {
  getPreferences,
  getWhitelist,
  setWhitelist,
  type SyncWhitelist,
  updatePreferences,
  type UserPreferences,
} from '../../storage/preferences';

export interface DataSourceContextValue {
  isDemo: boolean;
  db: RmOneNoteDatabase;
  sendMessage: (request: RuntimeRequest) => Promise<RuntimeResponse>;
  getAllDocs: () => Promise<DocumentRecord[]>;
  getPrefs: () => Promise<UserPreferences>;
  updatePrefs: (patch: Partial<UserPreferences>) => Promise<UserPreferences>;
  getWl: () => Promise<SyncWhitelist>;
  setWl: (whitelist: SyncWhitelist) => Promise<SyncWhitelist>;
  saveWhitelist: (whitelist: SyncWhitelist) => Promise<SaveWhitelistSelectionResult>;
  getAuthSummary: () => Promise<AuthStatusSummary>;
}

const defaultLiveDataSource: DataSourceContextValue = {
  isDemo: false,
  db: realDb,
  sendMessage: async (request: RuntimeRequest) => {
    return (await ext.runtime.sendMessage(request)) as RuntimeResponse;
  },
  getAllDocs: async () => getAllDocuments(realDb),
  getPrefs: async () => getPreferences(),
  updatePrefs: async (patch: Partial<UserPreferences>) => updatePreferences(patch),
  getWl: async () => getWhitelist(),
  setWl: async (whitelist: SyncWhitelist) => setWhitelist(whitelist),
  saveWhitelist: async (whitelist: SyncWhitelist) => saveWhitelistAndReconcilePages(whitelist, realDb),
  getAuthSummary: async () => getAuthStatusSummary(),
};

const DataSourceContext = createContext<DataSourceContextValue>(defaultLiveDataSource);

export function useDataSource(): DataSourceContextValue {
  return useContext(DataSourceContext);
}

export interface DataSourceProviderProps {
  value?: DataSourceContextValue;
  children: React.ReactNode;
}

export function DataSourceProvider({ value, children }: DataSourceProviderProps) {
  return (
    <DataSourceContext.Provider value={value ?? defaultLiveDataSource}>
      {children}
    </DataSourceContext.Provider>
  );
}


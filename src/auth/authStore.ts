import { ext } from '../shared/browser';

const RM_AUTH_STORAGE_KEY = 'rmAuth';
const MS_AUTH_STORAGE_KEY = 'msAuth';
const MS_CONFIG_STORAGE_KEY = 'msAuthConfig';

export const DEFAULT_AZURE_TENANT_ID = 'common';
const PLACEHOLDER_CLIENT_ID = '__REPLACE_ME__';

/**
 * Public OAuth 2.0 Application (Client) ID for Microsoft Entra ID (Authorization Code + PKCE).
 * Paste your Azure App Registration UUID directly here so end users never have to create
 * or enter an Azure App ID.
 *
 * Security note: In OAuth 2.0 PKCE public clients (RFC 7636), `client_id` is sent in plaintext
 * inside every `/authorize` URL and is public by design. Security is enforced by PKCE S256,
 * zero client secrets, delegated per-user consent, and locked extension Redirect URIs.
 */
export const BUILT_IN_AZURE_CLIENT_ID = '0a6b8d7c-e92a-47d9-8dd0-dc7e500ef798';

export interface RemarkableAuthState {
  deviceId: string;
  deviceToken: string;
  userToken: string | null;
  userTokenExpiresAtMs: number | null;
  pairedAt: string;
}

export interface MicrosoftAuthConfig {
  clientId: string;
  tenantId: string;
}

export interface MicrosoftAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  accountName: string | null;
  clientId: string;
  tenantId: string;
  connectedAt: string;
}

export interface AuthStatusSummary {
  remarkablePaired: boolean;
  remarkablePairedAt: string | null;
  microsoftConnected: boolean;
  microsoftAccount: string | null;
  microsoftExpiresAtMs: number | null;
  clientId: string;
  tenantId: string;
  redirectUri: string;
  isConfigured: boolean;
}

function cleanEnvValue(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === PLACEHOLDER_CLIENT_ID) {
    return '';
  }
  return trimmed;
}

function resolveEnvClientId(): string {
  try {
    return cleanEnvValue(import.meta.env?.VITE_AZURE_CLIENT_ID);
  } catch {
    return '';
  }
}

function resolveEnvTenantId(): string {
  try {
    return cleanEnvValue(import.meta.env?.VITE_AZURE_TENANT_ID) || DEFAULT_AZURE_TENANT_ID;
  } catch {
    return DEFAULT_AZURE_TENANT_ID;
  }
}

export function resolveExtensionRedirectUri(): string {
  try {
    if (ext.identity && typeof ext.identity.getRedirectURL === 'function') {
      return ext.identity.getRedirectURL();
    }
  } catch {
    // Fallback when inspected outside an active extension identity context
  }
  return '';
}

export async function getRemarkableAuth(): Promise<RemarkableAuthState | null> {
  const stored = await ext.storage.local.get(RM_AUTH_STORAGE_KEY);
  const candidate = stored[RM_AUTH_STORAGE_KEY] as Partial<RemarkableAuthState> | undefined;
  if (
    !candidate ||
    typeof candidate.deviceToken !== 'string' ||
    !candidate.deviceToken.trim() ||
    typeof candidate.deviceId !== 'string'
  ) {
    return null;
  }

  return {
    deviceId: candidate.deviceId,
    deviceToken: candidate.deviceToken,
    userToken: typeof candidate.userToken === 'string' ? candidate.userToken : null,
    userTokenExpiresAtMs:
      typeof candidate.userTokenExpiresAtMs === 'number' ? candidate.userTokenExpiresAtMs : null,
    pairedAt:
      typeof candidate.pairedAt === 'string' ? candidate.pairedAt : new Date().toISOString(),
  };
}

export async function saveRemarkableAuth(state: RemarkableAuthState): Promise<void> {
  await ext.storage.local.set({ [RM_AUTH_STORAGE_KEY]: state });
}

export async function clearRemarkableAuth(): Promise<void> {
  await ext.storage.local.remove(RM_AUTH_STORAGE_KEY);
}

export async function getMicrosoftAuthConfig(): Promise<MicrosoftAuthConfig> {
  const stored = await ext.storage.local.get(MS_CONFIG_STORAGE_KEY);
  const raw = stored[MS_CONFIG_STORAGE_KEY] as Partial<MicrosoftAuthConfig> | undefined;

  const storedClientId = cleanEnvValue(raw?.clientId);
  const storedTenantId = cleanEnvValue(raw?.tenantId);

  return {
    clientId: storedClientId || cleanEnvValue(BUILT_IN_AZURE_CLIENT_ID) || resolveEnvClientId(),
    tenantId: storedTenantId || resolveEnvTenantId(),
  };
}

export async function saveMicrosoftAuthConfig(
  patch: Partial<MicrosoftAuthConfig>,
): Promise<MicrosoftAuthConfig> {
  const current = await getMicrosoftAuthConfig();
  const next: MicrosoftAuthConfig = {
    clientId:
      patch.clientId !== undefined ? cleanEnvValue(patch.clientId) : current.clientId,
    tenantId:
      patch.tenantId !== undefined
        ? cleanEnvValue(patch.tenantId) || DEFAULT_AZURE_TENANT_ID
        : current.tenantId,
  };

  await ext.storage.local.set({ [MS_CONFIG_STORAGE_KEY]: next });
  return next;
}

export async function getMicrosoftAuth(): Promise<MicrosoftAuthState | null> {
  const stored = await ext.storage.local.get(MS_AUTH_STORAGE_KEY);
  const candidate = stored[MS_AUTH_STORAGE_KEY] as Partial<MicrosoftAuthState> | undefined;

  if (
    !candidate ||
    typeof candidate.accessToken !== 'string' ||
    !candidate.accessToken ||
    typeof candidate.refreshToken !== 'string' ||
    !candidate.refreshToken ||
    typeof candidate.expiresAtMs !== 'number'
  ) {
    return null;
  }

  return {
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAtMs: candidate.expiresAtMs,
    accountName: typeof candidate.accountName === 'string' ? candidate.accountName : null,
    clientId: typeof candidate.clientId === 'string' ? candidate.clientId : '',
    tenantId:
      typeof candidate.tenantId === 'string' && candidate.tenantId
        ? candidate.tenantId
        : DEFAULT_AZURE_TENANT_ID,
    connectedAt:
      typeof candidate.connectedAt === 'string'
        ? candidate.connectedAt
        : new Date().toISOString(),
  };
}

export async function saveMicrosoftAuth(state: MicrosoftAuthState): Promise<void> {
  await ext.storage.local.set({ [MS_AUTH_STORAGE_KEY]: state });
}

export async function clearMicrosoftAuth(): Promise<void> {
  await ext.storage.local.remove(MS_AUTH_STORAGE_KEY);
}

export async function getAuthStatusSummary(): Promise<AuthStatusSummary> {
  const [rmAuth, msAuth, msConfig] = await Promise.all([
    getRemarkableAuth(),
    getMicrosoftAuth(),
    getMicrosoftAuthConfig(),
  ]);

  const remarkablePaired = Boolean(rmAuth?.deviceToken);
  const microsoftConnected = Boolean(msAuth?.refreshToken);

  return {
    remarkablePaired,
    remarkablePairedAt: rmAuth?.pairedAt ?? null,
    microsoftConnected,
    microsoftAccount: msAuth?.accountName ?? null,
    microsoftExpiresAtMs: msAuth?.expiresAtMs ?? null,
    clientId: msConfig.clientId,
    tenantId: msConfig.tenantId,
    redirectUri: resolveExtensionRedirectUri(),
    isConfigured: remarkablePaired && microsoftConnected,
  };
}


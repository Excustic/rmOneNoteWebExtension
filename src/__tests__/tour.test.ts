import { describe, expect, it } from 'vitest';
import { createDemoDataSource, demoDb, seedDemoDatabase } from '../options/demo/demoDataSource';
import { TOUR_STEPS } from '../options/tour/tourSteps';
import { buildFileTreeHierarchy } from '../remarkable';

describe('Interactive Onboarding Tour & Demo Mode', () => {
  it('defines a well-structured tour sequence covering Setup, Dashboard, Sync Control, and Settings', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(10);

    const stepIds = new Set<string>();
    for (const step of TOUR_STEPS) {
      expect(step.id).toBeTruthy();
      expect(stepIds.has(step.id)).toBe(false);
      stepIds.add(step.id);

      expect(step.title.trim()).toBeTruthy();
      expect(step.description.trim()).toBeTruthy();
      expect(['dashboard', 'sync-control', 'settings', 'setup']).toContain(step.route);
    }

    // Verify folder auto-sync emphasis requirement is present
    const folderStep = TOUR_STEPS.find((s) => s.id === 'sync-control-folder-select');
    expect(folderStep).toBeDefined();
    expect(folderStep?.emphasis).toBe(true);
    expect(folderStep?.description).toContain('automatic future syncing');
    expect(folderStep?.description).toContain('new notebook or page you create inside this folder');

    // Verify slide targets for refined onboarding requirements
    const overviewStep = TOUR_STEPS.find((s) => s.id === 'dashboard-overview');
    expect(overviewStep?.target).toBe('dashboard-overview-cards');

    const resizeStep = TOUR_STEPS.find((s) => s.id === 'dashboard-resize-divider');
    expect(resizeStep?.target).toBe('container-resize-divider');

    const loadStep = TOUR_STEPS.find((s) => s.id === 'sync-control-load');
    expect(loadStep?.target).toBe('sync-control-load-btn');

    const settingsPrivacyStep = TOUR_STEPS.find((s) => s.id === 'settings-privacy');
    expect(settingsPrivacyStep?.target).toBe('settings-privacy-section');
    expect(settingsPrivacyStep?.emphasis).toBe(true);
    expect(settingsPrivacyStep?.description).toContain('profile sync storage');

    const settingsStep = TOUR_STEPS.find((s) => s.id === 'settings-holistic');
    expect(settingsStep?.target).toBe('settings-container');

    const setupMsIdx = TOUR_STEPS.findIndex((s) => s.id === 'setup-microsoft');
    const privacyIdx = TOUR_STEPS.findIndex((s) => s.id === 'settings-privacy');
    const settingsIdx = TOUR_STEPS.findIndex((s) => s.id === 'settings-holistic');
    const dashboardIdx = TOUR_STEPS.findIndex((s) => s.id === 'dashboard-overview');
    expect(setupMsIdx).toBeGreaterThan(-1);
    expect(privacyIdx).toBe(setupMsIdx + 1);
    expect(settingsIdx).toBe(privacyIdx + 1);
    expect(dashboardIdx).toBe(settingsIdx + 1);

    const sidebarTourStep = TOUR_STEPS.find((s) => s.id === 'tour-sidebar-button');
    expect(sidebarTourStep?.target).toBe('sidebar-tour-btn');

    const pageTagsStep = TOUR_STEPS.find((s) => s.id === 'sync-control-page-tags');
    expect(pageTagsStep?.target).toBe('sync-control-pages-list');
    expect(pageTagsStep?.description).toContain('Out of date');
    expect(pageTagsStep?.description).toContain('Reorder Pending');

    const deletedPagesStep = TOUR_STEPS.find((s) => s.id === 'sync-control-deleted-pages');
    expect(deletedPagesStep?.target).toBe('sync-control-deleted-pages');
    expect(deletedPagesStep?.description).toContain('Deleted on tablet');

    // Ensure redundant expand step is removed
    const redundantExpandStep = TOUR_STEPS.find((s) => s.id === 'sync-control-expand');
    expect(redundantExpandStep).toBeUndefined();
  });

  it('seeds isolated demo database with rich test hierarchy and page statuses', async () => {
    await seedDemoDatabase();

    const docs = await demoDb.documents.toArray();
    const pages = await demoDb.pages.toArray();
    const notebooks = await demoDb.notebooks.toArray();

    expect(docs.length).toBe(9);
    expect(pages.length).toBe(11);
    expect(notebooks.length).toBe(2);

    const roots = buildFileTreeHierarchy(docs);
    const visibleRootNames = roots.map((r) => r.visibleName);
    expect(visibleRootNames).toContain('University');
    expect(visibleRootNames).toContain('Work');
    expect(visibleRootNames).toContain('Quick Notes');

    const statuses = new Set(pages.map((p) => p.status));
    expect(statuses.has('Uploaded')).toBe(true);
    expect(statuses.has('Failed')).toBe(true);
    expect(statuses.has('Pending')).toBe(true);
    expect(statuses.has('Deleted')).toBe(true);
    expect(pages.some((p) => p.titleRenameOnly)).toBe(true);
    expect(pages.some((p) => p.fileSizeBytes === 0)).toBe(true);
  });

  it('handles simulated messaging and state transitions in demo mode without affecting real storage', async () => {
    await seedDemoDatabase();
    let overviewState: unknown = null;
    const ds = createDemoDataSource((next) => {
      overviewState = next;
    });

    // Simulated pairing
    const pairRes = await ds.sendMessage({
      type: 'PAIR_REMARKABLE',
      code: 'demo1234',
    });
    expect(pairRes.ok).toBe(true);
    if (pairRes.ok) {
      expect(pairRes.state.remarkablePaired).toBe(true);
    }

    // Simulated Microsoft sign-in
    const msRes = await ds.sendMessage({
      type: 'SIGN_IN_MICROSOFT',
    });
    expect(msRes.ok).toBe(true);
    if (msRes.ok) {
      expect(msRes.state.microsoftConnected).toBe(true);
      expect(msRes.state.isConfigured).toBe(true);
    }

    // Simulated manual sync followed by Abort Sync
    const syncRes = await ds.sendMessage({
      type: 'TRIGGER_MANUAL_SYNC',
    });
    expect(syncRes.ok).toBe(true);
    if (syncRes.ok) {
      expect(syncRes.state.phase).toBe('Uploading');
    }
    expect(overviewState).toBeDefined();

    const abortRes = await ds.sendMessage({
      type: 'ABORT_SYNC',
    });
    expect(abortRes.ok).toBe(true);
    if (abortRes.ok) {
      expect(abortRes.state.phase).toBe('Idle');
    }

    // Demo whitelist saving reconciles demo pages
    const saveRes = await ds.saveWhitelist({
      syncFiles: [],
      syncFolders: ['demo-f-uni'],
    });
    expect(saveRes.savedWhitelist.syncFolders).toEqual(['demo-f-uni']);
    expect(saveRes.pendingPagesCount).toBeGreaterThan(0);
  });
});

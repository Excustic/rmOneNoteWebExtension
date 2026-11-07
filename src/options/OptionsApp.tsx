import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ext } from '../shared/browser';
import {
  DEFAULT_SYNC_OVERVIEW,
  type RuntimeResponse,
  type SyncOverviewState,
} from '../shared/messaging';
import {
  DEFAULT_CONTAINER_WIDTH_PX,
  MAX_CONTAINER_WIDTH_PX,
  MIN_CONTAINER_WIDTH_PX,
  getPreferences,
  onSyncStorageChanged,
  updatePreferences,
} from '../storage/preferences';
import { dismissBackupImportWarning } from '../storage/syncLedger';
import { Sidebar } from './components/Sidebar';
import { useHashRoute } from './hooks/useHashRoute';
import { DashboardView } from './views/DashboardView';
import { SettingsView } from './views/SettingsView';
import { SetupView } from './views/SetupView';
import { SyncControlView } from './views/SyncControlView';

function clampContainerWidth(value: number): number {
  return Math.min(
    MAX_CONTAINER_WIDTH_PX,
    Math.max(MIN_CONTAINER_WIDTH_PX, Math.round(value))
  );
}

type ResizeEdgeSide = 'left' | 'right';

export function OptionsApp() {
  const { route, navigate } = useHashRoute();
  const [overview, setOverview] = useState<SyncOverviewState>(DEFAULT_SYNC_OVERVIEW);
  const [containerWidthPx, setContainerWidthPx] = useState<number>(DEFAULT_CONTAINER_WIDTH_PX);
  const [activeDragSide, setActiveDragSide] = useState<ResizeEdgeSide | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    side: ResizeEdgeSide;
    startX: number;
    startWidth: number;
    latestWidth: number;
  } | null>(null);

  const refreshOverview = useCallback(async () => {
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'GET_SYNC_OVERVIEW',
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        setOverview(response.state);
      }
    } catch (err) {
      console.error('[rmOneNote] Failed to load sync overview in options:', err);
    }
  }, []);

  useEffect(() => {
    void refreshOverview();
    void getPreferences().then((prefs) => {
      setContainerWidthPx(prefs.containerWidthPx);
    });

    const onStorageChange = (changes: Record<string, unknown>, areaName: string) => {
      if (
        areaName === 'local' &&
        ('rmAuth' in changes || 'msAuth' in changes || 'syncOverview' in changes)
      ) {
        void refreshOverview();
      }
    };

    ext.storage.onChanged.addListener(onStorageChange);
    const unsubscribeSync = onSyncStorageChanged((changes) => {
      if ('prefs' in changes && !dragStateRef.current) {
        void getPreferences().then((prefs) => {
          setContainerWidthPx(prefs.containerWidthPx);
        });
      }
    });

    return () => {
      ext.storage.onChanged.removeListener(onStorageChange);
      unsubscribeSync();
    };
  }, [refreshOverview]);

  const handleDismissBackupWarning = useCallback(async () => {
    await dismissBackupImportWarning();
    await refreshOverview();
  }, [refreshOverview]);

  const handleContainerWidthChange = useCallback((nextWidthPx: number, persist = false) => {
    const clamped = clampContainerWidth(nextWidthPx);
    setContainerWidthPx(clamped);
    if (persist) {
      void updatePreferences({ containerWidthPx: clamped });
    }
  }, []);

  const handleResizePointerDown = (
    side: ResizeEdgeSide,
    e: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const measuredWidth = containerRef.current
      ? Math.round(containerRef.current.getBoundingClientRect().width)
      : containerWidthPx;
    const initialWidth = clampContainerWidth(measuredWidth);

    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      side,
      startX: e.clientX,
      startWidth: initialWidth,
      latestWidth: initialWidth,
    };
    setContainerWidthPx(initialWidth);
    setActiveDragSide(side);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const handleResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== e.pointerId) {
      return;
    }
    const deltaX = e.clientX - state.startX;
    // Because the container uses mx-auto centering, expanding/contracting width by 2 * deltaX
    // (negated for the left handle) keeps the grabbed handle locked directly under the cursor.
    const signedDelta = state.side === 'right' ? deltaX : -deltaX;
    const nextWidth = clampContainerWidth(state.startWidth + signedDelta * 2);
    state.latestWidth = nextWidth;
    setContainerWidthPx(nextWidth);
  };

  const finishResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== e.pointerId) {
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const finalWidth = state.latestWidth;
    dragStateRef.current = null;
    setActiveDragSide(null);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    void updatePreferences({ containerWidthPx: finalWidth });
  };

  const handleResizeDoubleClick = () => {
    handleContainerWidthChange(DEFAULT_CONTAINER_WIDTH_PX, true);
  };

  const handleResizeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      handleContainerWidthChange(containerWidthPx + step, true);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      handleContainerWidthChange(containerWidthPx - step, true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      handleContainerWidthChange(MIN_CONTAINER_WIDTH_PX, true);
    } else if (e.key === 'End') {
      e.preventDefault();
      handleContainerWidthChange(MAX_CONTAINER_WIDTH_PX, true);
    }
  };

  function renderActiveView() {
    switch (route) {
      case 'setup':
        return (
          <SetupView
            overview={overview}
            onAuthStateChanged={(next) => {
              if (next) {
                setOverview(next);
              } else {
                void refreshOverview();
              }
            }}
            onFinish={() => navigate('dashboard')}
          />
        );
      case 'sync-control':
        return (
          <SyncControlView
            overview={overview}
            onOpenSetup={() => navigate('setup')}
            onSyncStateChanged={(next) => {
              if (next) {
                setOverview(next);
              } else {
                void refreshOverview();
              }
            }}
          />
        );
      case 'settings':
        return (
          <SettingsView
            overview={overview}
            containerWidthPx={containerWidthPx}
            onContainerWidthChange={handleContainerWidthChange}
            onOpenSetup={() => navigate('setup')}
            onBackupStateChanged={() => void refreshOverview()}
          />
        );
      case 'dashboard':
      default:
        return (
          <DashboardView
            overview={overview}
            onNavigate={navigate}
            onDismissBackupWarning={() => void handleDismissBackupWarning()}
            onSyncStateChanged={(next) => {
              if (next) {
                setOverview(next);
              } else {
                void refreshOverview();
              }
            }}
          />
        );
    }
  }

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <a
        href="#main-heading"
        className="visually-hidden fixed top-3 left-3 z-50 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-md"
      >
        Skip to main content
      </a>

      <Sidebar activeRoute={route} isConfigured={overview.isConfigured} />

      <main className="flex-1 overflow-y-auto px-8 py-8 lg:px-12 lg:py-10">
        <div
          ref={containerRef}
          className="relative mx-auto min-h-[calc(100vh-5rem)] w-full px-6"
          style={{ maxWidth: `${containerWidthPx}px` }}
        >
          {/* Left edge resize divider */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize main container width from left edge"
            aria-valuemin={MIN_CONTAINER_WIDTH_PX}
            aria-valuemax={MAX_CONTAINER_WIDTH_PX}
            aria-valuenow={containerWidthPx}
            tabIndex={0}
            title={`Drag to resize container width (${containerWidthPx}px). Double-click to reset.`}
            onPointerDown={(e) => handleResizePointerDown('left', e)}
            onPointerMove={handleResizePointerMove}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onDoubleClick={handleResizeDoubleClick}
            onKeyDown={handleResizeKeyDown}
            data-side="left"
            data-dragging={activeDragSide === 'left' ? 'true' : 'false'}
            data-peer-dragging={activeDragSide === 'right' ? 'true' : 'false'}
            className="container-resize-handle hidden lg:block"
          />

          {renderActiveView()}

          {/* Right edge resize divider */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize main container width from right edge"
            aria-valuemin={MIN_CONTAINER_WIDTH_PX}
            aria-valuemax={MAX_CONTAINER_WIDTH_PX}
            aria-valuenow={containerWidthPx}
            tabIndex={0}
            title={`Drag to resize container width (${containerWidthPx}px). Double-click to reset.`}
            onPointerDown={(e) => handleResizePointerDown('right', e)}
            onPointerMove={handleResizePointerMove}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onDoubleClick={handleResizeDoubleClick}
            onKeyDown={handleResizeKeyDown}
            data-side="right"
            data-dragging={activeDragSide === 'right' ? 'true' : 'false'}
            data-peer-dragging={activeDragSide === 'left' ? 'true' : 'false'}
            className="container-resize-handle hidden lg:block"
          />

          {activeDragSide !== null && (
            <span className="pointer-events-none fixed bottom-6 right-6 z-50 rounded-md bg-slate-900 px-2.5 py-1 font-mono text-xs font-medium text-white shadow-lg">
              Width: {containerWidthPx}px
            </span>
          )}
        </div>
      </main>
    </div>
  );
}

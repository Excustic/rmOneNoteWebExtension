import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
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
import { DataSourceProvider } from './context/DataSourceContext';
import { createDemoDataSource, seedDemoDatabase } from './demo/demoDataSource';
import { useHashRoute } from './hooks/useHashRoute';
import { TOUR_STEPS } from './tour/tourSteps';
import { TourOverlay } from './tour/TourOverlay';
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

  const [isTourActive, setIsTourActive] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const demoDataSource = useMemo(
    () => createDemoDataSource((next) => setOverview(next)),
    [],
  );

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

  const handleStartTour = useCallback(async (stepIndex = 0) => {
    await seedDemoDatabase();
    demoDataSource.setInitialSetupState(stepIndex <= 3);
    setOverview(demoDataSource.getOverview());
    setIsTourActive(true);
    setCurrentStepIndex(stepIndex);

    const step = TOUR_STEPS[stepIndex];
    if (step && step.route !== route) {
      navigate(step.route);
    }
  }, [demoDataSource, navigate, route]);

  const handleStopTour = useCallback(() => {
    setIsTourActive(false);
    void ext.storage.local.set({ rm_has_completed_tour: true });
    void refreshOverview();
  }, [refreshOverview]);

  const handleNextTourStep = useCallback(() => {
    if (currentStepIndex >= TOUR_STEPS.length - 1) {
      handleStopTour();
      return;
    }

    const nextIdx = currentStepIndex + 1;
    setCurrentStepIndex(nextIdx);

    const nextStep = TOUR_STEPS[nextIdx];
    if (nextStep && nextStep.route !== route) {
      navigate(nextStep.route);
    }
  }, [currentStepIndex, handleStopTour, navigate, route]);

  const handlePrevTourStep = useCallback(() => {
    if (currentStepIndex <= 0) {
      return;
    }

    const prevIdx = currentStepIndex - 1;
    setCurrentStepIndex(prevIdx);

    const prevStep = TOUR_STEPS[prevIdx];
    if (prevStep && prevStep.route !== route) {
      navigate(prevStep.route);
    }
  }, [currentStepIndex, navigate, route]);

  useEffect(() => {
    void refreshOverview();
    void getPreferences().then((prefs) => {
      setContainerWidthPx(prefs.containerWidthPx);
    });

    void ext.storage.local.get(['rm_has_completed_tour']).then((res) => {
      if (!res?.rm_has_completed_tour) {
        void handleStartTour(0);
      }
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
            currentTourStepId={currentStep?.id}
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

  const currentStep = isTourActive ? TOUR_STEPS[currentStepIndex] ?? null : null;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900">
      <a
        href="#main-heading"
        className="visually-hidden fixed top-3 left-3 z-50 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-md"
      >
        Skip to main content
      </a>

      <Sidebar
        activeRoute={route}
        isConfigured={overview.isConfigured}
        onStartTour={() => void handleStartTour(0)}
      />

      <main className="flex-1 h-full overflow-y-auto px-8 py-8 lg:px-12 lg:py-10">
        <div
          ref={containerRef}
          className="relative mx-auto min-h-[calc(100vh-5rem)] w-full px-6"
          style={{ maxWidth: `${containerWidthPx}px` }}
        >
          {isTourActive ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs text-blue-900 shadow-2xs">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" aria-hidden="true" />
                <span className="font-semibold">Interactive Demo Tour Active</span>
                <span className="text-blue-700">
                  You can click buttons and test features safely. Real data is not modified.
                </span>
              </div>
              <button
                type="button"
                onClick={handleStopTour}
                className="rounded border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-100"
              >
                Exit Tour
              </button>
            </div>
          ) : null}

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

          <DataSourceProvider value={isTourActive ? demoDataSource : undefined}>
            {renderActiveView()}
          </DataSourceProvider>

          {/* Right edge resize divider */}
          <div
            role="separator"
            data-tour="container-resize-divider"
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
            className="container-resize-handle block"
          />

          {activeDragSide !== null && (
            <span className="pointer-events-none fixed bottom-6 right-6 z-50 rounded-md bg-slate-900 px-2.5 py-1 font-mono text-xs font-medium text-white shadow-lg">
              Width: {containerWidthPx}px
            </span>
          )}
        </div>
      </main>

      {isTourActive && currentStep ? (
        <TourOverlay
          step={currentStep}
          stepIndex={currentStepIndex}
          totalSteps={TOUR_STEPS.length}
          onNext={handleNextTourStep}
          onPrev={handlePrevTourStep}
          onSkip={handleStopTour}
        />
      ) : null}
    </div>
  );
}

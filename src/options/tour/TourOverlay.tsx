import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TourStepDefinition } from './tourSteps';

interface TourOverlayProps {
  step: TourStepDefinition;
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PADDING = 8;
const POPOVER_OFFSET = 12;
const POPOVER_WIDTH = 380;

export function TourOverlay({
  step,
  stepIndex,
  totalSteps,
  onNext,
  onPrev,
  onSkip,
}: TourOverlayProps) {
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const nextBtnRef = useRef<HTMLButtonElement | null>(null);

  const measureTarget = useCallback(() => {
    if (!step.target) {
      setTargetRect((prev) => (prev === null ? prev : null));
      return;
    }

    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) {
      setTargetRect((prev) => (prev === null ? prev : null));
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setTargetRect((prev) => {
        if (
          prev &&
          Math.abs(prev.top - rect.top) < 0.5 &&
          Math.abs(prev.left - rect.left) < 0.5 &&
          Math.abs(prev.width - rect.width) < 0.5 &&
          Math.abs(prev.height - rect.height) < 0.5
        ) {
          return prev;
        }
        return {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        };
      });
    } else {
      setTargetRect((prev) => (prev === null ? prev : null));
    }
  }, [step.target]);

  // Continuously track target element position across DOM layout shifts and animations
  useEffect(() => {
    if (!step.target) {
      return;
    }

    let rafId: number;
    const trackLoop = () => {
      measureTarget();
      rafId = requestAnimationFrame(trackLoop);
    };

    rafId = requestAnimationFrame(trackLoop);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [step.target, measureTarget]);

  // Try to find and scroll the target into view, then measure
  useLayoutEffect(() => {
    if (!step.target) {
      setTargetRect(null);
      return;
    }

    let rafId: number;
    let attempts = 0;

    const findAndMeasure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        measureTarget();
        return;
      }

      attempts += 1;
      if (attempts < 20) {
        rafId = requestAnimationFrame(findAndMeasure);
      } else {
        setTargetRect(null);
      }
    };

    findAndMeasure();

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [step.target, step.route, measureTarget]);

  // Reposition on window resize or scroll
  useEffect(() => {
    window.addEventListener('resize', measureTarget);
    window.addEventListener('scroll', measureTarget, true);
    return () => {
      window.removeEventListener('resize', measureTarget);
      window.removeEventListener('scroll', measureTarget, true);
    };
  }, [measureTarget]);

  // Programmatic focus routing per persistent-app-tours guidance
  useEffect(() => {
    const timer = setTimeout(() => {
      nextBtnRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [stepIndex]);

  // Calculate popover fixed positioning
  const popoverStyle: React.CSSProperties = {};
  const isCentered = !step.target || !targetRect;

  if (isCentered) {
    popoverStyle.position = 'fixed';
    popoverStyle.top = '50%';
    popoverStyle.left = '50%';
    popoverStyle.transform = 'translate(-50%, -50%)';
    popoverStyle.width = 'min(92vw, 480px)';
  } else {
    popoverStyle.position = 'fixed';
    popoverStyle.width = `min(90vw, ${POPOVER_WIDTH}px)`;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const placement = step.preferredPlacement ?? 'bottom';

    let top = 0;
    let left = 0;

    if (placement === 'bottom') {
      top = targetRect.top + targetRect.height + POPOVER_OFFSET;
      left = targetRect.left + targetRect.width / 2 - POPOVER_WIDTH / 2;

      // Flip to top if overflowing bottom
      if (top + 280 > viewportH && targetRect.top - 280 > 0) {
        top = targetRect.top - 280 - POPOVER_OFFSET;
      }
    } else if (placement === 'top') {
      top = targetRect.top - 260 - POPOVER_OFFSET;
      left = targetRect.left + targetRect.width / 2 - POPOVER_WIDTH / 2;

      // Flip to bottom if overflowing top
      if (top < 16) {
        top = targetRect.top + targetRect.height + POPOVER_OFFSET;
      }
    } else if (placement === 'right') {
      left = targetRect.left + targetRect.width + POPOVER_OFFSET;
      top = targetRect.top;

      // Flip to bottom if overflowing right
      if (left + POPOVER_WIDTH + 16 > viewportW) {
        top = targetRect.top + targetRect.height + POPOVER_OFFSET;
        left = targetRect.left;
      }
    } else if (placement === 'left') {
      left = targetRect.left - POPOVER_WIDTH - POPOVER_OFFSET;
      top = targetRect.top;

      // Flip to bottom if overflowing left
      if (left < 16) {
        top = targetRect.top + targetRect.height + POPOVER_OFFSET;
        left = targetRect.left;
      }
    }

    // Clamp inside viewport
    left = Math.max(16, Math.min(left, viewportW - POPOVER_WIDTH - 16));
    top = Math.max(16, Math.min(top, viewportH - 300));

    popoverStyle.top = `${top}px`;
    popoverStyle.left = `${left}px`;
  }

  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === totalSteps - 1;

  return (
    <>
      {/* Dimmed backdrop with cut-out spotlight */}
      {targetRect ? (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: `${targetRect.top - SPOTLIGHT_PADDING}px`,
            left: `${targetRect.left - SPOTLIGHT_PADDING}px`,
            width: `${targetRect.width + SPOTLIGHT_PADDING * 2}px`,
            height: `${targetRect.height + SPOTLIGHT_PADDING * 2}px`,
            borderRadius: '8px',
            boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.65)',
            pointerEvents: 'none',
            zIndex: 9990,
            transition: 'top 0.2s ease-out, left 0.2s ease-out, width 0.2s ease-out, height 0.2s ease-out',
            border: '2px solid rgba(59, 130, 246, 0.8)',
          }}
        />
      ) : step.target ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[9990] bg-slate-900/30 transition-opacity"
        />
      ) : (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-[9990] bg-slate-900/65 transition-opacity"
        />
      )}

      {/* Persistent Popover Dialog per persistent-app-tours */}
      <div
        ref={popoverRef}
        popover="manual"
        role="dialog"
        aria-labelledby="tour-step-title"
        aria-describedby="tour-step-desc"
        style={{
          ...popoverStyle,
          zIndex: 9995,
        }}
        className="block rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl transition-all"
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <span className="rounded bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-brand">
              Demo Tour
            </span>
            <span className="text-xs font-medium text-slate-500">
              {stepIndex + 1} of {totalSteps}
            </span>
          </div>

          <button
            type="button"
            onClick={onSkip}
            aria-label="Skip tour and exit demo mode"
            className="rounded px-2 py-0.5 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            Skip Tour
          </button>
        </div>

        <div className="mt-3">
          <h2 id="tour-step-title" className="text-base font-semibold text-slate-900">
            {step.title}
          </h2>

          <p id="tour-step-desc" className="mt-2 text-xs leading-relaxed text-slate-600">
            {step.description}
          </p>

          {step.emphasis ? (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950">
              <span className="font-semibold text-amber-900">Key Feature: </span>
              Folders sync all current and future sub-items automatically.
            </div>
          ) : null}

          {step.interactiveHint ? (
            <div className="mt-2.5 flex items-center gap-1.5 rounded bg-slate-100 px-2.5 py-1.5 text-[11px] text-slate-600">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />
              <span>{step.interactiveHint}</span>
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onPrev}
            disabled={isFirstStep}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:invisible"
          >
            Back
          </button>

          <div className="flex items-center gap-2">
            <button
              ref={nextBtnRef}
              type="button"
              onClick={onNext}
              className="rounded bg-brand px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
            >
              {step.primaryButtonLabel ?? (isLastStep ? 'Finish Tour' : 'Next')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}


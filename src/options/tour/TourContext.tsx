import React, { createContext, useCallback, useContext, useState } from 'react';
import type { OptionsRouteId } from '../../shared/routes';
import { ext } from '../../shared/browser';
import { TOUR_STEPS, type TourStepDefinition } from './tourSteps';

interface TourContextValue {
  isTourActive: boolean;
  currentStepIndex: number;
  currentStep: TourStepDefinition | null;
  totalSteps: number;
  startTour: (stepIndex?: number) => void;
  stopTour: () => void;
  nextStep: () => void;
  prevStep: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

const TOUR_SEEN_KEY = 'rm_has_completed_tour';

export interface TourProviderProps {
  currentRoute: OptionsRouteId;
  onNavigate: (route: OptionsRouteId) => void;
  onTourStateChange?: (isActive: boolean) => void;
  children: React.ReactNode;
}

export function TourProvider({
  currentRoute,
  onNavigate,
  onTourStateChange,
  children,
}: TourProviderProps) {
  const [isTourActive, setIsTourActive] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const startTour = useCallback((stepIndex = 0) => {
    setIsTourActive(true);
    setCurrentStepIndex(stepIndex);
    onTourStateChange?.(true);

    const step = TOUR_STEPS[stepIndex];
    if (step && step.route !== currentRoute) {
      onNavigate(step.route);
    }
  }, [currentRoute, onNavigate, onTourStateChange]);

  const stopTour = useCallback(() => {
    setIsTourActive(false);
    onTourStateChange?.(false);
    void ext.storage.local.set({ [TOUR_SEEN_KEY]: true });
  }, [onTourStateChange]);

  const nextStep = useCallback(() => {
    if (currentStepIndex >= TOUR_STEPS.length - 1) {
      stopTour();
      return;
    }

    const nextIdx = currentStepIndex + 1;
    setCurrentStepIndex(nextIdx);

    const nextStepDef = TOUR_STEPS[nextIdx];
    if (nextStepDef && nextStepDef.route !== currentRoute) {
      onNavigate(nextStepDef.route);
    }
  }, [currentStepIndex, currentRoute, onNavigate, stopTour]);

  const prevStep = useCallback(() => {
    if (currentStepIndex <= 0) {
      return;
    }

    const prevIdx = currentStepIndex - 1;
    setCurrentStepIndex(prevIdx);

    const prevStepDef = TOUR_STEPS[prevIdx];
    if (prevStepDef && prevStepDef.route !== currentRoute) {
      onNavigate(prevStepDef.route);
    }
  }, [currentStepIndex, currentRoute, onNavigate]);

  const currentStep = isTourActive ? TOUR_STEPS[currentStepIndex] ?? null : null;

  return (
    <TourContext.Provider
      value={{
        isTourActive,
        currentStepIndex,
        currentStep,
        totalSteps: TOUR_STEPS.length,
        startTour,
        stopTour,
        nextStep,
        prevStep,
      }}
    >
      {children}
    </TourContext.Provider>
  );
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    throw new Error('useTour must be used within a TourProvider');
  }
  return ctx;
}

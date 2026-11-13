import { useEffect, useRef, useState } from 'react';

/**
 * Formats remaining milliseconds as zero-padded `MM:SS` for the auto-sync countdown.
 */
export function formatCountdownMmSs(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface NextSyncCountdownProps {
  nextAutoSyncAt: string | null;
  isConfigured: boolean;
  isSyncing?: boolean;
  onCountdownElapsed?: () => void;
  className?: string;
}

/**
 * Displays a subtle clock icon and `mm:ss` countdown until the next background alarm sync.
 */
export function NextSyncCountdown({
  nextAutoSyncAt,
  isConfigured,
  isSyncing = false,
  onCountdownElapsed,
  className = '',
}: NextSyncCountdownProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastElapsedRefreshMsRef = useRef(0);

  const parsedTargetMs = nextAutoSyncAt ? Date.parse(nextAutoSyncAt) : Number.NaN;
  const isVisible =
    isConfigured && !isSyncing && nextAutoSyncAt !== null && !Number.isNaN(parsedTargetMs);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isVisible, nextAutoSyncAt]);

  const remainingMs = isVisible ? Math.max(0, parsedTargetMs - nowMs) : 0;

  useEffect(() => {
    if (!isVisible || remainingMs > 0 || !onCountdownElapsed) {
      return;
    }

    const now = Date.now();
    if (now - lastElapsedRefreshMsRef.current >= 2000) {
      lastElapsedRefreshMsRef.current = now;
      onCountdownElapsed();
    }
  }, [isVisible, remainingMs, nowMs, onCountdownElapsed]);

  if (!isVisible) {
    return null;
  }

  const formatted = formatCountdownMmSs(remainingMs);

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 tabular-nums ${className}`.trim()}
      title={`Next automatic sync in ${formatted}`}
      aria-label={`Next automatic sync in ${formatted}`}
    >
      <span className="countdown-icon-clock" aria-hidden="true" />
      <span>{formatted}</span>
    </span>
  );
}


export const TOUR_STORAGE_KEY = 'sq_tour';
export const TOUR_VERSION = 1;
const TOUR_STEP_COUNT = 14;

export interface TourProgress {
  version: number;
  completed: boolean;
  step: number;
}

export function defaultTourProgress(): TourProgress {
  return { version: TOUR_VERSION, completed: false, step: 0 };
}

export function readTourProgress(): TourProgress {
  try {
    const value = localStorage.getItem(TOUR_STORAGE_KEY);
    if (!value) return defaultTourProgress();
    const progress: unknown = JSON.parse(value);
    if (
      !progress ||
      typeof progress !== 'object' ||
      !('version' in progress) ||
      !('completed' in progress) ||
      !('step' in progress) ||
      progress.version !== TOUR_VERSION ||
      typeof progress.completed !== 'boolean' ||
      typeof progress.step !== 'number' ||
      !Number.isFinite(progress.step) ||
      !Number.isInteger(progress.step) ||
      progress.step < 0 ||
      progress.step >= TOUR_STEP_COUNT
    ) return defaultTourProgress();
    return progress as TourProgress;
  } catch {
    return defaultTourProgress();
  }
}

export function writeTourProgress(progress: TourProgress): void {
  try { localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(progress)); } catch {}
}

export function clearTourProgress(): void {
  try { localStorage.removeItem(TOUR_STORAGE_KEY); } catch {}
}

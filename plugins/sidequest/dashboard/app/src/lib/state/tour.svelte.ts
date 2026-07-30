import type { BoardState } from './board.svelte';
import { clearTourProgress, defaultTourProgress, readTourProgress, writeTourProgress, type TourProgress } from './tour-storage';
import { TOUR_STEPS, type TourStep } from '../tour/steps';

export class TourState {
  active = $state(false);
  index = $state(0);
  steps: TourStep[] = TOUR_STEPS;
  step = $derived(this.steps[this.index] ?? null);
  progress = $state<TourProgress>(readTourProgress());

  constructor(private board: BoardState) {}

  start(from = 0) {
    if (this.active) this.leaveStep();
    this.index = this.availableIndex(this.clampIndex(from), 1) ?? this.clampIndex(from);
    this.active = true;
    this.enterStep();
  }

  next() {
    if (!this.active) return;
    const index = this.availableIndex(this.index + 1, 1);
    if (index === null) {
      this.finish();
      return;
    }
    this.leaveStep();
    this.index = index;
    this.persist(false, index);
    this.enterStep();
  }

  prev() {
    if (!this.active || this.index === 0) return;
    const index = this.availableIndex(this.index - 1, -1);
    if (index === null) return;
    this.leaveStep();
    this.index = index;
    this.persist(false, index);
    this.enterStep();
  }

  skip() {
    if (this.active) this.leaveStep();
    this.active = false;
    this.persist(true, this.index);
  }

  finish() {
    if (this.active) this.leaveStep();
    this.active = false;
    this.index = 0;
    this.persist(true, 0);
  }

  reset() {
    clearTourProgress();
    this.progress = defaultTourProgress();
    this.start(0);
  }

  maybeAutoStart() {
    if (this.active || this.progress.completed) return;
    this.start(this.progress.step);
  }

  private enterStep() { this.step?.enter?.(this.board); }
  private leaveStep() { this.step?.exit?.(this.board); }

  private availableIndex(index: number, direction: 1 | -1) {
    for (let current = index; current >= 0 && current < this.steps.length; current += direction) {
      const step = this.steps[current];
      if (this.stepIsAvailable(step)) return current;
    }
    return null;
  }

  private stepIsAvailable(step: TourStep) {
    if (!step.optional) return true;
    if (step.available) return step.available(this.board);
    return !step.target || this.targetExists(step.target);
  }

  private targetExists(target: string) {
    return typeof document !== 'undefined' && Boolean(document.querySelector(target));
  }

  private clampIndex(index: number) {
    return Math.min(Math.max(Math.trunc(index), 0), this.steps.length - 1);
  }

  private persist(completed: boolean, step: number) {
    this.progress = { version: this.progress.version, completed, step };
    writeTourProgress(this.progress);
  }
}

import { cycleB } from './cycle-b';

export function cycleA(): string {
  return `a:${cycleB()}`;
}

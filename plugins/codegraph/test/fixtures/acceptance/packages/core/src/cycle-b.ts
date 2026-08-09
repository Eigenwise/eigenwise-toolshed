import { cycleA } from './cycle-a';

export function cycleB(): string {
  return `b:${cycleA()}`;
}

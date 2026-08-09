import { Duplicate as ImportedDuplicate } from './duplicate.js';

export class Duplicate {
  readonly source = 'legacy';
}

export function legacyCall(value) {
  return new ImportedDuplicate().source + value?.missing?.();
}

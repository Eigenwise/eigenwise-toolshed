export interface BaseContract {
  render(): string;
}

export class Base implements BaseContract {
  render(): string {
    return 'base';
  }
}

export class Duplicate {
  readonly source = 'core';
}

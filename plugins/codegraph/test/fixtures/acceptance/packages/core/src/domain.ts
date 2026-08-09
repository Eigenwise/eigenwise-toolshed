// @ts-nocheck
import { Base } from '@core/shared/base';
import { helper } from '@core/shared/helper';

export interface Derived {
  render(): string;
}

export class Child extends Base implements Derived {
  override render(): string {
    return helper(super.render());
  }
}

export function buildChild(): Child {
  return new Child();
}

export const childAlias = buildChild;

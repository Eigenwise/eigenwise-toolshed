import { Base, greet as welcome } from './base.js';

export class Child extends Base {
  override run(): string {
    return welcome('graph');
  }
}

new Child().run();

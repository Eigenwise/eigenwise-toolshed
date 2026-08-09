export class Base {
  run(): string {
    return 'base';
  }
}

export function greet(name: string): string {
  return `hello ${name}`;
}

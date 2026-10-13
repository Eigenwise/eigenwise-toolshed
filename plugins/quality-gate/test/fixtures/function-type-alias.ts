type StartupCapture = (
  properties: Readonly<Record<string, unknown>>,
  options?: { readonly transport: "sendBeacon" },
) => void;

export function send(value: number): number {
  return value + 2;
}

export const noop: StartupCapture = () => {};

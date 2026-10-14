import { vi } from "vitest";

export function stubWebLocks(): void {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn(async <T,>(_name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
    const previous = tails.get(_name) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(_name, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (tails.get(_name) === current) tails.delete(_name);
    }
  });
  const testNavigator = Object.create(navigator) as Navigator;
  Object.defineProperty(testNavigator, "locks", { configurable: true, value: { request } });
  vi.stubGlobal("navigator", testNavigator);
}

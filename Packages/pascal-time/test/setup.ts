// Test environment shim: Pascal's scene store defers dirty marking to `requestAnimationFrame`
// (see `updateNodesAction`), which does not exist in Node. Without this the dirty-node set can
// never grow headlessly, and any test asserting "driving left the dirty count at zero" would
// pass whether or not that were true. The shim makes the counter real; `flushFrame` below is
// how a test waits for a scheduled mark to land. Scope: vitest setup for this package only.

type FrameCallback = (time: number) => void;

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((callback: FrameCallback): number =>
    setTimeout(() => callback(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame;

  globalThis.cancelAnimationFrame = ((handle: number): void => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }) as typeof cancelAnimationFrame;
}

/** Let any animation-frame callback the store scheduled actually run. */
export const flushFrame = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

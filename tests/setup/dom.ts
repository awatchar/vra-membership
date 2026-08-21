import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// Registers the DOM matchers and their types in one import.
import '@testing-library/jest-dom/vitest';

/**
 * jsdom lifecycle and the browser APIs jsdom does not implement.
 *
 * Storage is cleared **before** every test rather than after, so a test that
 * inspects it is looking only at what this test put there - the assertion "no
 * image was written to storage" is worthless if a previous test could have left
 * one behind.
 *
 * `fetch` is deliberately left alone. Every web test installs its own stub, so a
 * component that reaches the network unexpectedly fails loudly rather than
 * hitting something real.
 *
 * The canvas and `createImageBitmap` stubs below stand in for the browser's
 * rasteriser, which jsdom has none of. They are doubles for the *platform*, not
 * for anything in this repository: the code under test still calls
 * `createImageBitmap`, `getContext('2d')`, `drawImage` and `toBlob` in the same
 * order with the same arguments, and a test can inspect what it asked for. What
 * cannot be checked here is the resulting pixels, which is a real limit.
 */

/** A one-pixel JPEG, so a stubbed encode returns something plausible. */
const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

interface DrawCall {
  arguments: unknown[];
}

/** Every `drawImage` call made during a test, so geometry can be asserted. */
export const drawCalls: DrawCall[] = [];

function installCanvasStub(): void {
  const proto = globalThis.HTMLCanvasElement?.prototype;
  if (!proto) return;

  proto.getContext = function getContext(): unknown {
    return {
      drawImage: (...args: unknown[]) => {
        drawCalls.push({ arguments: args });
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      fillRect: () => undefined,
      clearRect: () => undefined,
    };
  } as typeof proto.getContext;

  proto.toBlob = function toBlob(callback: BlobCallback, type?: string): void {
    callback(new Blob([TINY_JPEG], { type: type ?? 'image/jpeg' }));
  };
}

function installImageBitmapStub(): void {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = () =>
    Promise.resolve({ width: 1200, height: 900, close: () => undefined });
}

installCanvasStub();
installImageBitmapStub();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  drawCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

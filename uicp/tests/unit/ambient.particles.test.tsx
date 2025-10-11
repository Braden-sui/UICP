import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import AmbientParticles from '../../src/components/AmbientParticles';

// Helper to mock matchMedia per test
function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('AmbientParticles', () => {
  afterEach(() => {
    cleanup();
    // Reset matchMedia to avoid cross-test leakage
    // @ts-expect-error allow delete for test cleanup
    delete window.matchMedia;
  });

  it('respects prefers-reduced-motion by not spawning particles', () => {
    mockMatchMedia(true);
    const { getByTestId } = render(<AmbientParticles />);
    const container = getByTestId('ambient-particles-container');
    expect(container.childNodes.length).toBe(0);
  });

  it('spawns particles when reduced motion is not preferred', () => {
    mockMatchMedia(false);
    const { getByTestId } = render(<AmbientParticles />);
    const container = getByTestId('ambient-particles-container');
    expect(container.childNodes.length).toBeGreaterThan(0);
  });
});

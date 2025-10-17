import { useEffect, useRef, useState } from 'react';
import { applyDynamicStyleRule, removeDynamicStyleRule, escapeForSelector } from '../lib/css/dynamicStyles';

/**
 * AmbientParticles Component
 *
 * Adds subtle floating particles and ambient animations to create
 * a premium, polished desktop environment. Particles are lightweight
 * and non-distracting, adding depth and visual interest.
 *
 * Features:
 * - Floating light particles with randomized paths
 * - Gentle pulsing/fading animations
 * - GPU-accelerated transforms for smooth performance
 * - Responsive to viewport size
 */

interface Particle {
  id: number;
  token: string;
  x: number;
  y: number;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
  floatX: number;
  floatY: number;
}

const PARTICLE_COUNT = 15;

const createRunToken = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ambient-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
};

// Accessibility: respect user motion preferences and keep animations subtle.
// We avoid React re-render churn by drawing particles via DOM once on mount.
const AmbientParticles = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [prefersReduced, setPrefersReduced] = useState(false);

  // Detect reduced motion preference once and subscribe to changes.
  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReduced(!!mq.matches);
      const onChange = (e: MediaQueryListEvent) => setPrefersReduced(!!e.matches);
      // Modern browsers: addEventListener, fallback to addListener for older engines.
      if ('addEventListener' in mq) mq.addEventListener('change', onChange);
      // @ts-expect-error legacy API support
      else mq.addListener?.(onChange);
      return () => {
        if ('removeEventListener' in mq) mq.removeEventListener('change', onChange);
        // @ts-expect-error legacy API support
        else mq.removeListener?.(onChange);
      };
    } catch {
      // Fail closed (no crash) if matchMedia is unavailable.
      setPrefersReduced(false);
    }
  }, []);

  useEffect(() => {
    // Generate particles with randomized properties for natural movement
    // Honor reduced motion: skip dynamic particles entirely.
    const container = containerRef.current;
    if (!container) return undefined;

    if (prefersReduced) {
      container.innerHTML = '';
      return undefined;
    }

    const runToken = createRunToken();
    const selectors: string[] = [];
    const elements: HTMLElement[] = [];

    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      id: i,
      token: `${runToken}-${i}`,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 3 + 1,
      duration: Math.random() * 20 + 15,
      delay: Math.random() * -10,
      opacity: Math.random() * 0.15 + 0.05,
      floatX: Math.random() * 80 - 40,
      floatY: Math.random() * -60 - 40,
    }));

    particles.forEach((particle) => {
      const el = document.createElement('div');
      el.className = 'ambient-particle';
      el.dataset.ambientParticle = particle.token;
      container.appendChild(el);
      elements.push(el);

      const selector = `[data-ambient-particle="${escapeForSelector(particle.token)}"]`;
      selectors.push(selector);

      const innerOpacity = (particle.opacity * 2).toFixed(3);
      const outerOpacity = particle.opacity.toFixed(3);

      applyDynamicStyleRule(selector, {
        left: `${particle.x.toFixed(2)}%`,
        top: `${particle.y.toFixed(2)}%`,
        width: `${particle.size.toFixed(2)}px`,
        height: `${particle.size.toFixed(2)}px`,
        background: `radial-gradient(circle, rgba(255,255,255,${innerOpacity}), rgba(99,102,241,${outerOpacity}))`,
        opacity: particle.opacity.toFixed(3),
        animation: `float-particle ${particle.duration.toFixed(2)}s ease-in-out ${particle.delay.toFixed(2)}s infinite`,
        'will-change': 'transform, opacity',
        '--float-x': `${particle.floatX.toFixed(2)}px`,
        '--float-y': `${particle.floatY.toFixed(2)}px`,
      });
    });

    return () => {
      selectors.forEach(removeDynamicStyleRule);
      elements.forEach((el) => {
        if (el.parentElement === container) {
          container.removeChild(el);
        }
      });
    };
  }, [prefersReduced]);

  return (
    <>
      {/* Particle container */}
      <div
        ref={containerRef}
        className="pointer-events-none fixed inset-0 z-[1]"
        data-testid="ambient-particles-container"
        aria-hidden="true"
      />

      {/* Ambient shimmer overlay for subtle light effects */}
      {!prefersReduced && (
        <div
          className="pointer-events-none fixed inset-0 z-[1] opacity-30 ambient-shimmer-layer"
          aria-hidden="true"
        />
      )}

      {/* Light rays effect for depth */}
      {!prefersReduced && (
        <div
          className="pointer-events-none fixed inset-0 z-[1] opacity-20 ambient-light-rays-layer"
          aria-hidden="true"
        />
      )}
    </>
  );
};

export default AmbientParticles;

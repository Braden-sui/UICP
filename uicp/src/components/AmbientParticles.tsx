import { useEffect, useRef, useState } from 'react';

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
  x: number;
  y: number;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
}

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
    if (prefersReduced) return;

    const particles: Particle[] = Array.from({ length: 15 }, (_, i) => ({
      id: i,
      x: Math.random() * 100, // percentage
      y: Math.random() * 100,
      size: Math.random() * 3 + 1, // 1-4px
      duration: Math.random() * 20 + 15, // 15-35s
      delay: Math.random() * -10, // Stagger start times
      opacity: Math.random() * 0.15 + 0.05, // 0.05-0.2
    }));

    // Create particle elements dynamically
    const container = containerRef.current;
    if (!container) return;

    particles.forEach((particle) => {
      const el = document.createElement('div');
      el.className = 'ambient-particle';
      el.style.cssText = `
        position: absolute;
        left: ${particle.x}%;
        top: ${particle.y}%;
        width: ${particle.size}px;
        height: ${particle.size}px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255,255,255,${particle.opacity * 2}), rgba(99,102,241,${particle.opacity}));
        pointer-events: none;
        animation: float-particle ${particle.duration}s ease-in-out ${particle.delay}s infinite;
        will-change: transform, opacity;
      `;
      container.appendChild(el);
    });

    // Cleanup on unmount
    return () => {
      container.innerHTML = '';
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
          className="pointer-events-none fixed inset-0 z-[1] opacity-30"
          style={{
            background: `
              radial-gradient(circle at 20% 30%, rgba(139,92,246,0.03), transparent 50%),
              radial-gradient(circle at 80% 70%, rgba(236,72,153,0.03), transparent 50%),
              radial-gradient(circle at 50% 50%, rgba(99,102,241,0.02), transparent 60%)
            `,
            animation: 'shimmer-pulse 15s ease-in-out infinite',
          }}
          aria-hidden="true"
        />
      )}

      {/* Light rays effect for depth */}
      {!prefersReduced && (
        <div
          className="pointer-events-none fixed inset-0 z-[1] opacity-20"
          style={{
            background: `
              linear-gradient(45deg, transparent 40%, rgba(255,255,255,0.03) 50%, transparent 60%),
              linear-gradient(-45deg, transparent 40%, rgba(255,255,255,0.02) 50%, transparent 60%)
            `,
            backgroundSize: '200% 200%',
            animation: 'light-rays 25s linear infinite',
          }}
          aria-hidden="true"
        />
      )}

      {/* CSS animations for particles and ambient effects */}
      <style>{`
        /* Respect user motion preferences globally for this component */
        @media (prefers-reduced-motion: reduce) {
          .ambient-particle { animation: none !important; }
        }

        @keyframes float-particle {
          0%, 100% {
            transform: translate(0, 0) scale(1);
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          50% {
            transform: translate(var(--float-x, 30px), var(--float-y, -60px)) scale(1.2);
            opacity: 0.8;
          }
          90% {
            opacity: 1;
          }
        }

        @keyframes shimmer-pulse {
          0%, 100% {
            opacity: 0.2;
          }
          50% {
            opacity: 0.4;
          }
        }

        @keyframes light-rays {
          0% {
            background-position: 0% 0%;
          }
          100% {
            background-position: 200% 200%;
          }
        }

        /* Apply random float directions using CSS custom properties */
        .ambient-particle:nth-child(odd) {
          --float-x: 40px;
          --float-y: -80px;
        }
        .ambient-particle:nth-child(even) {
          --float-x: -30px;
          --float-y: -70px;
        }
        .ambient-particle:nth-child(3n) {
          --float-x: 20px;
          --float-y: -90px;
        }
      `}</style>
    </>
  );
};

export default AmbientParticles;

# Motion Animation System

**Status**: ✅ Active (v1.0)
**Location**: `uicp/src/lib/ui/animation.ts`
**Dependencies**: `motion` (v12.23.24+)

## Overview

The UICP frontend uses [Motion](https://motion.dev/) for interactive React component animations, replacing CSS-only animations for windows, panels, and icons. Ambient background effects (gradients, orbs, particles) remain CSS-driven for performance.

**Why Motion?**
- **Physics-based springs**: Natural micro-interactions without manual easing curves
- **Presence animations**: Built-in mount/unmount with exit transitions
- **Reduced motion respect**: Automatic fallback via `prefers-reduced-motion`
- **Performance**: GPU-accelerated transforms via WAAPI when available

## Architecture

### Animation Tokens
**File**: `uicp/src/lib/ui/animation.ts`

Centralized animation configuration that maps CSS custom properties to Motion configs:

```typescript
import {
  windowVariants,
  getWindowTransition,
  iconSpring,
  isReducedMotion
} from '../lib/ui/animation';
```

**Key Functions**:
- `getAnimationDurations()` - Reads CSS variables (`:root.anim-*` classes)
- `isReducedMotion()` - Checks `:root.anim-none`, `.anim-reduced`, or media query
- `getWindowTransition()` - Returns Motion transition respecting user preferences
- `getTransition(ms, easing)` - Utility for custom animations

**Variants**:
- `windowVariants` - Window enter/exit (opacity, scale, y)
- `panelSlideVariants` - Panel slide-in animations
- `iconHoverScale` / `iconPressScale` - Icon micro-interactions

### Motion Provider
**File**: `uicp/src/App.tsx`

```tsx
<MotionConfig reducedMotion={!motionEnabled || isReducedMotion() ? 'always' : 'user'}>
  {/* app */}
</MotionConfig>
```

- Wraps entire app in `MotionConfig`
- Reads `motionEnabled` flag from app state
- Maps to Motion's `reducedMotion` setting

### Feature Flag
**State**: `useAppStore((s) => s.motionEnabled)` (default: `true`)
**Setter**: `setMotionEnabled(boolean)`
**Persisted**: Yes (localStorage via Zustand)

**Kill Switch**: Set `motionEnabled = false` to revert to CSS-only animations.

## Migration Status

### ✅ Migrated Components

| Component | Type | Features |
|-----------|------|----------|
| **DesktopWindow.tsx** | Presence | AnimatePresence, enter/exit variants, spring physics |
| **DesktopIcon.tsx** | Interactive | Hover/press springs, scale animations |
| LogsPanel.tsx | Inherited | Uses DesktopWindow wrapper |
| MetricsPanel.tsx | Inherited | Uses DesktopWindow wrapper |

### ❌ Out of Scope (CSS-only)

These remain CSS animations for performance (no JS cost):

- Ambient gradients (`gradient-shift`)
- Floating orbs (`orb-float-1`, `orb-float-2`)
- Shimmer/light rays (`shimmer-pulse`, `light-rays`)
- Particle system (`AmbientParticles.tsx`)
- Dock thinking pulse (`dock-thinking-pulse`)
- Icon glow/pulse for active state

## Usage Patterns

### Window/Panel Presence

```tsx
import { AnimatePresence, motion } from 'motion/react';
import { windowVariants, getWindowTransition } from '../lib/ui/animation';
import { useAppStore } from '../state/app';

const MyPanel = ({ isOpen }) => {
  const motionEnabled = useAppStore((s) => s.motionEnabled);
  const transition = getWindowTransition();

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={motionEnabled ? windowVariants.initial : false}
          animate={motionEnabled ? windowVariants.animate : false}
          exit={motionEnabled ? windowVariants.exit : false}
          transition={transition}
        >
          {/* content */}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
```

**Key Points**:
- Always wrap in `<AnimatePresence>`
- Pass `false` to `initial`/`animate`/`exit` when Motion disabled
- Use `getWindowTransition()` for consistent timing
- Gate animations with `motionEnabled` flag

### Icon Micro-Interactions

```tsx
import { motion } from 'motion/react';
import { iconSpring, iconHoverScale, iconPressScale } from '../lib/ui/animation';

const MyIcon = () => {
  const motionEnabled = useAppStore((s) => s.motionEnabled);
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  return (
    <motion.div
      animate={
        motionEnabled
          ? isPressed ? iconPressScale : isHovered ? iconHoverScale : { scale: 1, y: 0 }
          : undefined
      }
      transition={motionEnabled ? iconSpring : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={() => setIsPressed(true)}
      onPointerUp={() => setIsPressed(false)}
    >
      {/* icon */}
    </motion.div>
  );
};
```

**Key Points**:
- Use `animate` (not `whileHover`/`whileTap`) for explicit state control
- Track hover/press state manually for better control
- Fallback to `undefined` when Motion disabled (CSS takes over)

## Reduced Motion Contract

The system respects accessibility preferences via multiple layers:

### 1. CSS Variables
```css
:root.anim-none {
  --animation-duration-fast: 0s;
  --animation-duration-normal: 0s;
  /* ... */
}
```

### 2. Motion Config
```tsx
<MotionConfig reducedMotion="always"> {/* forces instant transitions */}
```

### 3. Component-level Checks
```tsx
const reduced = isReducedMotion();
const transition = reduced ? { duration: 0 } : { duration: 0.4 };
```

### 4. Media Query Fallback
```css
@media (prefers-reduced-motion: reduce) {
  :root:not(.anim-normal):not(.anim-reduced):not(.anim-none) {
    --animation-duration-fast: 0.05s;
    /* ... */
  }
}
```

**Priority**: `:root.anim-*` classes → `prefers-reduced-motion` media query

## Telemetry

UI animation events are tracked via the telemetry system:

**Events**:
- `ui.anim.window.enter` - Window mount animation started
- `ui.anim.window.exit` - Window exit animation started
- `ui.anim.panel.enter` - Panel slide-in
- `ui.anim.panel.exit` - Panel slide-out
- `ui.anim.frame_drop` - Animation jank detected

**Span**: `ui`
**Location**: `uicp/src/lib/telemetry/types.ts`

### Example Usage

```typescript
import { emitTelemetryEvent } from '../lib/telemetry';

// In component mount/unmount
emitTelemetryEvent('ui.anim.window.enter', {
  traceId: 'current-trace-id',
  durationMs: 400,
  data: { windowId: 'logs', motionEnabled: true },
});
```

## Performance Budget

**Baseline**: Pure CSS animations (opacity, transform) on GPU-accelerated properties.

**Target Delta**: ≤ 5% CPU/frame time increase with Motion enabled.

**Measurement**:
1. Open DevTools Performance panel
2. Record window open/close sequence
3. Compare frame time p95 (Motion enabled vs CSS fallback)
4. Ensure p95 ≤ 16.67ms (60fps)

**Optimization**:
- Motion uses WAAPI when available (same as CSS)
- Spring animations only active during hover/press
- AnimatePresence unmounts components cleanly

## CSS Fallback

When `motionEnabled = false`, components fall back to CSS:

```css
/* Fallback for icons when Motion disabled */
.desktop-icon:not([data-motion-enabled]) .desktop-icon-inner {
  transition: transform 0.3s ease-out;
}

.desktop-icon:not([data-motion-enabled]):hover .desktop-icon-inner {
  transform: translateY(-4px) scale(1.05);
}
```

**Note**: Windows use `display: none` instead of CSS animations when closed (no enter/exit animation without Motion).

## Rollback Plan

### Immediate Kill Switch
Set feature flag in localStorage:

```javascript
// In browser console
const state = JSON.parse(localStorage.getItem('uicp-app'));
state.motionEnabled = false;
localStorage.setItem('uicp-app', JSON.stringify(state));
location.reload();
```

### Code Rollback
Revert these commits to restore CSS-only animations:
1. `DesktopWindow.tsx` - Remove `AnimatePresence` wrapper
2. `DesktopIcon.tsx` - Remove `motion.div` and spring configs
3. `global.css` - Restore `window-appear` keyframe and `.workspace-window` animation
4. Remove `motion` from `package.json`

### Per-Component Fallback
If only one component has issues, set `initial={false}` to bypass Motion:

```tsx
<motion.div
  initial={false}  // skip entrance animation
  animate={false}  // no animations
>
```

## Testing

### Manual Verification
1. **Window animations**: Open/close Logs or Metrics panels → verify smooth entrance/exit
2. **Icon springs**: Hover desktop icons → verify lift + scale bounce
3. **Reduced motion**: Toggle OS preference → verify instant transitions
4. **Feature flag**: Set `motionEnabled = false` → verify CSS fallback

### Automated Tests
Located in `uicp/tests/unit/**`:

```typescript
describe('DesktopWindow Motion', () => {
  it('mounts with entrance animation when Motion enabled', () => {
    render(<DesktopWindow isOpen motionEnabled />);
    // Assert initial opacity: 0, scale: 0.92
  });

  it('skips animation when reduced motion active', () => {
    mockReducedMotion(true);
    render(<DesktopWindow isOpen motionEnabled />);
    // Assert immediate full opacity
  });
});
```

## Troubleshooting

### Animation not running
1. Check `motionEnabled` flag: `useAppStore.getState().motionEnabled`
2. Verify `MotionConfig` wrapper in `App.tsx`
3. Inspect `reducedMotion` setting (should be `'user'` if enabled)
4. Check browser console for Motion errors

### Jank/dropped frames
1. Open DevTools Performance panel
2. Look for long tasks during animation
3. Verify transforms/opacity only (GPU-accelerated)
4. Check if `will-change` is applied
5. Disable Motion via feature flag if persistent

### Animations too fast/slow
1. Check CSS variables in `:root.anim-*` classes
2. Verify `getAnimationDurations()` returns expected values
3. Adjust spring config in `animation.ts` (stiffness/damping)

### Accessibility violations
1. Ensure all animations respect `isReducedMotion()`
2. Verify `MotionConfig reducedMotion` prop is dynamic
3. Test with OS preference enabled
4. Confirm zero-duration transitions when disabled

## Future Enhancements

### Potential Additions
- **Drag inertia**: Add physics to icon/window dragging
- **Layout animations**: Animate desktop icon repositioning
- **Stagger children**: Panel list items cascade-in
- **Gesture-driven**: Swipe-to-close for panels

### Not Planned
- **Route transitions**: No routing in UICP
- **Scroll-linked**: Ambient effects remain CSS
- **Complex orchestration**: Keep animations simple

## References

- [Motion Documentation](https://motion.dev/)
- [WAAPI Compatibility](https://caniuse.com/web-animation)
- [Reduced Motion Guide](https://web.dev/prefers-reduced-motion/)
- Animation tokens: `uicp/src/lib/ui/animation.ts`
- Feature flags: `uicp/src/lib/uicp/adapters/adapter.featureFlags.ts`

---

**Last Updated**: 2025-10-22
**Owner**: UICP Frontend Team
**Status**: ✅ Production Ready

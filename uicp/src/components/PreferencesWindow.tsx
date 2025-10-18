import { useCallback, useMemo } from 'react';
import type { ChangeEvent } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppSelector, useAppStore } from '../state/app';
import {
  usePreferencesStore,
  type DockBehavior,
  type AnimationSpeed,
  type FontSize,
} from '../state/preferences';

// Dock behavior options
const DOCK_BEHAVIOR_OPTIONS: ReadonlyArray<{ value: DockBehavior; label: string; description: string }> = [
  { value: 'proximity', label: 'Proximity', description: 'Show when mouse near bottom edge (default)' },
  { value: 'auto-hide', label: 'Auto-hide', description: 'Hide after 2.5s of inactivity' },
  { value: 'always-visible', label: 'Always visible', description: 'Never hide the dock' },
];

// Animation speed options
const ANIMATION_OPTIONS: ReadonlyArray<{ value: AnimationSpeed; label: string; description: string }> = [
  { value: 'normal', label: 'Normal', description: 'Full animations at standard speed' },
  { value: 'reduced', label: 'Reduced', description: 'Faster animations, less motion' },
  { value: 'none', label: 'None', description: 'Disable all animations' },
];

// Font size options
const FONT_SIZE_OPTIONS: ReadonlyArray<{ value: FontSize; label: string; description: string }> = [
  { value: 'small', label: 'Small', description: '87.5% base size' },
  { value: 'medium', label: 'Medium', description: '100% base size (default)' },
  { value: 'large', label: 'Large', description: '112.5% base size' },
  { value: 'x-large', label: 'Extra Large', description: '125% base size' },
];

const PreferencesWindow = () => {
  const preferencesOpen = useAppSelector((state) => state.preferencesOpen);
  const setPreferencesOpen = useAppSelector((state) => state.setPreferencesOpen);
  const fullControl = useAppSelector((state) => state.fullControl);
  const fullControlLocked = useAppSelector((state) => state.fullControlLocked);
  const setFullControl = useAppStore((state) => state.setFullControl);

  const dockBehavior = usePreferencesStore((state) => state.dockBehavior);
  const setDockBehavior = usePreferencesStore((state) => state.setDockBehavior);
  const animationSpeed = usePreferencesStore((state) => state.animationSpeed);
  const setAnimationSpeed = usePreferencesStore((state) => state.setAnimationSpeed);
  const fontSize = usePreferencesStore((state) => state.fontSize);
  const setFontSize = usePreferencesStore((state) => state.setFontSize);

  const handleClose = useCallback(() => setPreferencesOpen(false), [setPreferencesOpen]);

  const handleDockBehaviorChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setDockBehavior(event.target.value as DockBehavior);
    },
    [setDockBehavior],
  );

  const handleAnimationSpeedChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setAnimationSpeed(event.target.value as AnimationSpeed);
    },
    [setAnimationSpeed],
  );

  const handleFontSizeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setFontSize(event.target.value as FontSize);
    },
    [setFontSize],
  );

  const currentDockBehaviorLabel = useMemo(
    () => DOCK_BEHAVIOR_OPTIONS.find((opt) => opt.value === dockBehavior)?.label ?? 'Proximity',
    [dockBehavior],
  );

  const currentAnimationLabel = useMemo(
    () => ANIMATION_OPTIONS.find((opt) => opt.value === animationSpeed)?.label ?? 'Normal',
    [animationSpeed],
  );

  const currentFontSizeLabel = useMemo(
    () => FONT_SIZE_OPTIONS.find((opt) => opt.value === fontSize)?.label ?? 'Medium',
    [fontSize],
  );

  return (
    <DesktopWindow
      id="preferences"
      title="Preferences"
      isOpen={preferencesOpen}
      onClose={handleClose}
      initialPosition={{ x: 200, y: 140 }}
      width={520}
      minWidth={480}
      minHeight={480}
    >
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {/* Agent Control Section */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
              Agent Control
            </h3>
            <div className="rounded border border-slate-200 bg-white/90 p-3 shadow-sm">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={fullControl}
                  disabled={fullControlLocked}
                  onChange={(e) => setFullControl(e.target.checked)}
                />
                <span className="text-slate-700">
                  Enable Full Control
                  <span className="block text-xs text-slate-500">
                    When enabled, the agent applies plans automatically without Preview. {fullControlLocked ? 'Full control is locked until re-enabled from DockChat.' : ''}
                  </span>
                </span>
              </label>
            </div>
          </section>

          {/* Appearance Section */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
              Appearance
            </h3>
            <div className="space-y-4">
              {/* Font Size */}
              <div>
                <label htmlFor="font-size-select" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Font Size
                </label>
                <select
                  id="font-size-select"
                  value={fontSize}
                  onChange={handleFontSizeChange}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {FONT_SIZE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} — {option.description}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-slate-500">
                  Current: {currentFontSizeLabel}
                </p>
              </div>
            </div>
          </section>

          {/* Behavior Section */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
              Behavior
            </h3>
            <div className="space-y-4">
              {/* Dock Behavior */}
              <div>
                <label htmlFor="dock-behavior-select" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Dock Behavior
                </label>
                <select
                  id="dock-behavior-select"
                  value={dockBehavior}
                  onChange={handleDockBehaviorChange}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {DOCK_BEHAVIOR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} — {option.description}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-slate-500">
                  Current: {currentDockBehaviorLabel}
                </p>
              </div>
            </div>
          </section>

          {/* Accessibility Section */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
              Accessibility
            </h3>
            <div className="space-y-4">
              {/* Animation Speed */}
              <div>
                <label htmlFor="animation-select" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Animation Speed
                </label>
                <select
                  id="animation-select"
                  value={animationSpeed}
                  onChange={handleAnimationSpeedChange}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {ANIMATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} — {option.description}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-slate-500">
                  Current: {currentAnimationLabel}
                </p>
              </div>
            </div>
          </section>

          {/* Info Section */}
          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs text-slate-600">
              💡 <strong>Tip:</strong> Changes are applied immediately and saved automatically. You can open preferences
              anytime from the desktop shortcut or menu bar.
            </p>
          </section>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default PreferencesWindow;

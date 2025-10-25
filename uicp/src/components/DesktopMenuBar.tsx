import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

export type DesktopMenuAction = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

export type DesktopMenu = {
  id: string;
  label: string;
  actions: DesktopMenuAction[];
};

export type DesktopMenuBarProps = {
  menus: DesktopMenu[];
};

// DesktopMenuBar renders a lightweight menu strip similar to macOS with simple dropdown actions per menu entry.
const DesktopMenuBar = ({ menus }: DesktopMenuBarProps) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  const menuMap = useMemo(() => {
    return new Map(menus.map((menu) => [menu.id, menu] as const));
  }, [menus]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!barRef.current) return;
      if (!barRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const toggleMenu = useCallback((id: string) => {
    setOpenMenu((prev) => (prev === id ? null : id));
  }, []);

  const handleAction = useCallback((menuId: string, actionId: string) => {
    const menu = menuMap.get(menuId);
    if (!menu) return;
    const action = menu.actions.find((item) => item.id === actionId);
    if (!action || action.disabled) return;
    action.onSelect();
    setOpenMenu(null);
  }, [menuMap]);

  if (menus.length === 0) {
    return null;
  }

  return (
    <div
      ref={barRef}
      className="pointer-events-auto absolute left-0 right-0 top-0 z-50 flex items-center gap-2 border-b border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-slate-900 shadow-sm backdrop-blur-xl backdrop-saturate-150"
      role="menubar"
    >
      {menus.map((menu) => {
        const expanded = openMenu === menu.id;
        return (
          <div key={menu.id} className="relative">
            <button
              type="button"
              className={clsx(
                'rounded-lg px-2 py-1 transition-all duration-200 hover:bg-white/25 active:scale-95 focus:outline-none focus:ring-2 focus:ring-white/30 drop-shadow-sm',
                expanded && 'bg-white/25',
              )}
              aria-haspopup="true"
              aria-expanded={expanded}
              onClick={() => toggleMenu(menu.id)}
            >
              {menu.label}
            </button>
            {expanded && (
              <div
                role="menu"
                className="absolute left-0 top-full mt-1 min-w-[160px] rounded-2xl border border-white/30 bg-white/15 backdrop-blur-xl backdrop-saturate-150 p-1 text-slate-900 shadow-xl"
              >
                {menu.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    role="menuitem"
                    disabled={action.disabled}
                    onClick={() => handleAction(menu.id, action.id)}
                    className={clsx(
                      'flex w-full items-center justify-between rounded-xl px-3 py-1 text-left text-xs transition-all duration-200 drop-shadow-sm',
                      action.disabled
                        ? 'cursor-not-allowed text-slate-400'
                        : 'hover:bg-white/25 hover:text-slate-900 active:scale-95',
                    )}
                  >
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default DesktopMenuBar;

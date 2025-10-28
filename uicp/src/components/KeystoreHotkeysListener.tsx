import { useEffect } from 'react';
import { useKeystore } from '../state/keystore';
import { useAppStore } from '../state/app';

const isEditableTarget = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if ((node as HTMLElement).isContentEditable) return true;
  return false;
};

const getPlatformTag = () => {
  if (typeof navigator === 'undefined') return 'unknown';
  const platform = navigator.platform?.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return platform || 'unknown';
};

const KeystoreHotkeysListener = () => {
  const quickLock = useKeystore((s) => s.quickLock);
  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const key = event.key?.toLowerCase();
      const platform = getPlatformTag();
      // Quick Lock: Ctrl+Shift+L (Windows/Linux) or Cmd+Shift+L (mac)
      const isMod = platform === 'mac' ? event.metaKey : event.ctrlKey;
      if (key === 'l' && isMod && event.shiftKey) {
        try {
          await quickLock();
          useAppStore.getState().pushToast({ variant: 'info', message: 'Keystore locked' });
        } catch (err) {
          useAppStore.getState().pushToast({ variant: 'error', message: `Quick Lock failed: ${(err as Error)?.message ?? String(err)}` });
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [quickLock]);
  return null;
};

export default KeystoreHotkeysListener;

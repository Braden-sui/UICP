import { useEffect } from 'react';
import {
  applyDynamicStyleRule,
  removeDynamicStyleRule,
  type DynamicStyleDeclarations,
} from '../lib/css/dynamicStyles';

/**
 * Apply a dynamic CSS rule to the shared runtime stylesheet.
 * The rule persists across re-renders and is removed when the component unmounts
 * or the selector changes.
 */
export const useDynamicStyleRule = (
  selector: string | null,
  declarations: DynamicStyleDeclarations,
  deps: ReadonlyArray<unknown>,
) => {
  useEffect(() => {
    if (!selector) return;
    // Cleanup only when the selector itself changes or the component unmounts.
    return () => {
      removeDynamicStyleRule(selector);
    };
  }, [selector]);

  useEffect(() => {
    if (!selector) return;
    applyDynamicStyleRule(selector, declarations);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps handled via explicit array.
  }, [selector, ...deps]);
};

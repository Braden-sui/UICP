import type { PropsWithChildren } from 'react';

export type LiquidGlassProps = PropsWithChildren<{ className?: string }>;

// Lightweight stub so unit tests can render components without the native module.
export const LiquidGlass = ({ children }: LiquidGlassProps) => <>{children}</>;

export default LiquidGlass;


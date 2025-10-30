import { createContext, useContext, type ReactNode } from 'react';
import { useProblemDetailBanners } from '../components/ProblemDetailBanner';

/**
 * Context for managing ProblemDetail banners globally
 */
export type ProblemDetailContextType = ReturnType<typeof useProblemDetailBanners>;

const ProblemDetailContext = createContext<ProblemDetailContextType | null>(null);

interface ProblemDetailProviderProps {
  children: ReactNode;
}

/**
 * Provider component for ProblemDetail banner functionality
 */
export function ProblemDetailProvider({ children }: ProblemDetailProviderProps) {
  const bannerManager = useProblemDetailBanners();
  
  return (
    <ProblemDetailContext.Provider value={bannerManager}>
      {children}
    </ProblemDetailContext.Provider>
  );
}

/**
 * Hook to access ProblemDetail banner functionality
 */
export function useProblemDetail() {
  const context = useContext(ProblemDetailContext);
  if (!context) {
    throw new Error('useProblemDetail must be used within a ProblemDetailProvider');
  }
  return context;
}

/**
 * Convenience function to show a ProblemDetail banner from anywhere
 * Note: This should be called from within a component that has access to the context
 */
export function showProblemDetail() {
  // This is a placeholder - actual implementation should use the context
  console.warn('[showProblemDetail] Called outside of React context. Use useProblemDetail hook instead.');
}

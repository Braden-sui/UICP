import { useEffect, useState } from 'react';
import { X, AlertTriangle, Shield, Clock, Zap, Database } from 'lucide-react';
import type { ProblemDetail } from '../lib/llm/protocol/errors';
import { isProblemDetail } from '../lib/llm/protocol/errors';
import { isProblemDetailV1Enabled } from '../lib/flags';

interface ProblemDetailBannerProps {
  problem?: unknown;
  onDismiss?: () => void;
  className?: string;
}

/**
 * ProblemDetailBanner displays typed error information with remediation hints.
 * 
 * Features:
 * - Category-specific icons and colors
 * - Retry indicators for retryable errors
 * - Remediation hints when available
 * - Dismissible with smooth animations
 * - Respects feature flags for gradual rollout
 */
export function ProblemDetailBanner({ 
  problem, 
  onDismiss, 
  className = '' 
}: ProblemDetailBannerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);

  const detail = problem as ProblemDetail;
  
  useEffect(() => {
    if (detail) {
      setIsVisible(true);
    }
  }, [detail]);

  // Only render if ProblemDetail v1 is enabled and we have a valid problem
  if (!isProblemDetailV1Enabled() || !isProblemDetail(problem)) {
    return null;
  }

  const handleDismiss = () => {
    setIsDismissing(true);
    setTimeout(() => {
      setIsVisible(false);
      onDismiss?.();
    }, 200);
  };

  if (!isVisible) {
    return null;
  }

  const getCategoryInfo = (category: string) => {
    switch (category) {
      case 'auth':
        return {
          icon: Shield,
          color: 'bg-orange-50 border-orange-200 text-orange-900',
          iconColor: 'text-orange-600',
          title: 'Authentication Error',
        };
      case 'policy':
        return {
          icon: Database,
          color: 'bg-blue-50 border-blue-200 text-blue-900',
          iconColor: 'text-blue-600',
          title: 'Policy Error',
        };
      case 'rate_limit':
        return {
          icon: Clock,
          color: 'bg-yellow-50 border-yellow-200 text-yellow-900',
          iconColor: 'text-yellow-600',
          title: 'Rate Limited',
        };
      case 'transport':
        return {
          icon: Zap,
          color: 'bg-red-50 border-red-200 text-red-900',
          iconColor: 'text-red-600',
          title: 'Network Error',
        };
      case 'schema':
        return {
          icon: AlertTriangle,
          color: 'bg-purple-50 border-purple-200 text-purple-900',
          iconColor: 'text-purple-600',
          title: 'Schema Error',
        };
      default:
        return {
          icon: AlertTriangle,
          color: 'bg-gray-50 border-gray-200 text-gray-900',
          iconColor: 'text-gray-600',
          title: 'Error',
        };
    }
  };

  const categoryInfo = getCategoryInfo(detail.category);
  const Icon = categoryInfo.icon;

  return (
    <div
      className={`
        fixed top-4 right-4 z-50 max-w-md rounded-lg border p-4 shadow-lg
        transition-all duration-200 ease-in-out
        ${categoryInfo.color}
        ${isDismissing ? 'translate-x-full opacity-0' : 'translate-x-0 opacity-100'}
        ${className}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`flex-shrink-0 rounded-full p-1 ${categoryInfo.iconColor} bg-opacity-10`}>
          <Icon className="h-4 w-4" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="font-semibold text-sm">{categoryInfo.title}</h3>
            {detail.retryable && (
              <span className="inline-flex items-center rounded-full bg-opacity-20 px-2 py-0.5 text-xs font-medium bg-current">
                Retryable
              </span>
            )}
          </div>

          {/* Error Code */}
          {detail.code && (
            <p className="text-xs font-mono opacity-75 mb-2">
              Code: {detail.code}
            </p>
          )}

          {/* Detail Message */}
          {detail.detail && (
            <p className="text-sm mb-2">
              {detail.detail}
            </p>
          )}

          {/* Remediation Hint */}
          {detail.hint && (
            <div className="rounded bg-opacity-10 bg-current p-2 mb-2">
              <p className="text-xs font-medium mb-1">What you can do:</p>
              <p className="text-xs">{detail.hint}</p>
            </div>
          )}

          {/* HTTP Status */}
          {detail.http_status && (
            <p className="text-xs opacity-60">
              HTTP {detail.http_status}
              {detail.upstream_code && ` (Upstream: ${detail.upstream_code})`}
            </p>
          )}
        </div>

        {/* Dismiss Button */}
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 rounded-full p-1 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss error"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * Hook to manage ProblemDetail banners in application state
 */
export function useProblemDetailBanners() {
  const [banners, setBanners] = useState<Map<string, unknown>>(new Map());

  const showBanner = (id: string, problem: unknown) => {
    setBanners(prev => new Map(prev).set(id, problem));
  };

  const dismissBanner = (id: string) => {
    setBanners(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const clearAllBanners = () => {
    setBanners(new Map());
  };

  return {
    banners,
    showBanner,
    dismissBanner,
    clearAllBanners,
  };
}

export default ProblemDetailBanner;

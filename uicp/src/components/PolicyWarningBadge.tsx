import React from 'react';
import { ClarifierIcon } from '../icons';

interface PolicyWarningBadgeProps {
  message: string;
  variant?: 'warning' | 'error' | 'info';
  persistent?: boolean;
  className?: string;
}

export const PolicyWarningBadge: React.FC<PolicyWarningBadgeProps> = ({
  message,
  variant = 'warning',
  persistent = false,
  className = '',
}) => {
  const variantStyles = {
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  };

  const iconStyles = {
    warning: 'text-amber-500',
    error: 'text-red-500',
    info: 'text-blue-500',
  };

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${variantStyles[variant]} ${className}`}
      role="alert"
      aria-live={persistent ? 'polite' : 'assertive'}
    >
      <ClarifierIcon className={`h-4 w-4 ${iconStyles[variant]}`} />
      <span>{message}</span>
    </div>
  );
};

export default PolicyWarningBadge;

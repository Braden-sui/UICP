import type { SVGProps } from 'react';

// Inline icons keep DockChat dependencies minimal.
export const PaperclipIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
    <path d="M21 12.5L12.5 21a5 5 0 0 1-7.07-7.07l9-9a3 3 0 1 1 4.24 4.24l-9 9a1 1 0 0 1-1.41-1.41l8.3-8.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
    <path d="M4 4l16 8-16 8 4-8-4-8z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const StopIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </svg>
);
// LogsIcon: document with lines representing log entries.
export const LogsIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
    <path d="M8 3h6l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" strokeLinejoin="round" />
    <path d="M14 3v4h4" strokeLinejoin="round" />
    <path d="M8.75 9.5h6.5" strokeLinecap="round" />
    <path d="M8.75 12.5h6.5" strokeLinecap="round" />
    <path d="M8.75 15.5h4.5" strokeLinecap="round" />
  </svg>
);

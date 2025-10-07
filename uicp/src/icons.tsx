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

// NotepadIcon: lined page with a pencil marker for the local notes utility.
export const NotepadIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
    <rect x="5.5" y="3" width="13" height="18" rx="2" />
    <path d="M9 7h6" strokeLinecap="round" />
    <path d="M9 11h6" strokeLinecap="round" />
    <path d="M9 15h4.5" strokeLinecap="round" />
    <path d="M15.75 16.5l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16.5 15.75l-1.25 3.75 3.75-1.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// GaugeIcon: simple speedometer used for telemetry dashboards.
export const GaugeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
    <path d="M4 16a8 8 0 1 1 16 0" strokeLinejoin="round" />
    <path d="M12 8v4" strokeLinecap="round" />
    <path d="M12 12l3 3" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="16" r="1.5" />
  </svg>
);

export const GearIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
    <path
      d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm0-5.5 1.2 2.6a6.5 6.5 0 0 1 2.7 1.1L18.7 5l1.8 3.1-2.5 1.7a6.6 6.6 0 0 1 0 2.4l2.5 1.7-1.8 3.1-2.8-1.7a6.5 6.5 0 0 1-2.7 1.1L12 21l-1.2-2.6a6.5 6.5 0 0 1-2.7-1.1L5.3 19 3.5 15.9l2.5-1.7a6.6 6.6 0 0 1 0-2.4L3.5 10.1 5.3 7l2.8 1.7a6.5 6.5 0 0 1 2.7-1.1z"
      strokeLinejoin="round"
    />
  </svg>
);

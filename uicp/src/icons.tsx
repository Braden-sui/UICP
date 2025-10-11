import type { SVGProps } from 'react';

/**
 * Premium Icon Set - Unified Design System
 *
 * Design principles:
 * - Consistent 1.75 stroke width for premium feel
 * - Rounded caps and joins for modern aesthetic
 * - Balanced proportions with 2px corner radius where applicable
 * - Subtle dual-tone effects using opacity for depth
 * - Icons designed on 24x24 grid with consistent padding
 */

// PaperclipIcon: Attachment with refined curves and consistent stroke
export const PaperclipIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
    <path
      d="M21.5 11.5L11.5 21.5a5.5 5.5 0 0 1-7.78-7.78l10-10a3.5 3.5 0 1 1 4.95 4.95l-10 10a1.5 1.5 0 0 1-2.12-2.12l9-9"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.9"
    />
  </svg>
);

// SendIcon: Modern paper plane with refined geometry
export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...props}>
    <g strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l7.5 18 2.5-8 8-2.5L3 3z" opacity="0.9" />
      <path d="M10.5 10.5l10-7.5" opacity="0.6" />
    </g>
  </svg>
);

// StopIcon: Rounded square with premium corners
export const StopIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" opacity="0.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
// LogsIcon: Document with refined log entries and modern folded corner
export const LogsIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...props}>
    <g strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 3h7l5 5v11a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 19V5.5A2.5 2.5 0 0 1 7.5 3z" opacity="0.9" />
      <path d="M14.5 3v4.5h4.5" opacity="0.6" />
      <path d="M8.5 10h7" opacity="0.85" />
      <path d="M8.5 13.5h7" opacity="0.85" />
      <path d="M8.5 17h5" opacity="0.85" />
    </g>
  </svg>
);

// NotepadIcon: Elegant notepad with refined pencil accent
export const NotepadIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...props}>
    <g strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2.5" width="14" height="19" rx="2.5" opacity="0.9" />
      <path d="M8.5 7h7" opacity="0.75" />
      <path d="M8.5 11h7" opacity="0.75" />
      <path d="M8.5 15h5" opacity="0.75" />
      {/* Premium pencil accent with dual-tone for depth */}
      <path d="M16 17l3.5 3.5" opacity="0.9" />
      <path d="M17 16l-1.5 4.5 4.5-1.5" opacity="0.65" fill="currentColor" />
    </g>
  </svg>
);

// GaugeIcon: Modern speedometer with refined needle and arc
export const GaugeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...props}>
    <g strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 16.5a9 9 0 1 1 18 0" opacity="0.9" />
      {/* Refined tick marks for premium look */}
      <path d="M5.5 13L6 14" opacity="0.5" strokeWidth="2" />
      <path d="M9 8.5L9.5 9.5" opacity="0.5" strokeWidth="2" />
      <path d="M15 8.5L14.5 9.5" opacity="0.5" strokeWidth="2" />
      <path d="M18.5 13L18 14" opacity="0.5" strokeWidth="2" />
      {/* Dynamic needle */}
      <path d="M12 7.5V12" opacity="0.85" />
      <path d="M12 12l3.5 3.5" opacity="0.85" />
      <circle cx="12" cy="16.5" r="1.75" fill="currentColor" opacity="0.9" />
    </g>
  </svg>
);

// GearIcon: Premium settings gear with refined tooth geometry
export const GearIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...props}>
    <g strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {/* Outer gear teeth with consistent spacing */}
      <path
        d="M12 2.5l1 2.5a7 7 0 0 1 2.8 1.2l2.7-1 1.5 2.6-2.3 1.8a7 7 0 0 1 0 2.8l2.3 1.8-1.5 2.6-2.7-1a7 7 0 0 1-2.8 1.2l-1 2.5-1-2.5a7 7 0 0 1-2.8-1.2l-2.7 1-1.5-2.6 2.3-1.8a7 7 0 0 1 0-2.8L4 9.8l1.5-2.6 2.7 1A7 7 0 0 1 11 5l1-2.5z"
        opacity="0.9"
      />
      {/* Inner circle for depth */}
      <circle cx="12" cy="12" r="3.5" opacity="0.75" />
    </g>
  </svg>
);

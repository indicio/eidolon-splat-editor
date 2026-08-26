/** Tiny inline icons for compact panel controls. */

const base = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 } as const;

export const EyeIcon = () => (
    <svg {...base}>
        <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" />
    </svg>
);

export const EyeOffIcon = () => (
    <svg {...base} opacity={0.5}>
        <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
        <line x1="2" y1="14" x2="14" y2="2" />
    </svg>
);

export const LockIcon = () => (
    <svg {...base}>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
);

export const UnlockIcon = () => (
    <svg {...base} opacity={0.5}>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0" />
    </svg>
);

export const CrossIcon = () => (
    <svg {...base}>
        <line x1="4" y1="4" x2="12" y2="12" />
        <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
);

export const TargetIcon = () => (
    <svg {...base}>
        <circle cx="8" cy="8" r="5" />
        <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
);

export const AssignIcon = () => (
    <svg {...base}>
        <path d="M2 8h9" />
        <path d="M8 4.5 11.5 8 8 11.5" />
        <path d="M13.5 3v10" />
    </svg>
);

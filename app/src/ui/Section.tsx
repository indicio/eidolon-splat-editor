import { useState, type ReactNode } from 'react';

import styles from './Panel.module.scss';

/** Collapsible dock-panel section with persisted open state. */
export const Section = ({ title, children, defaultOpen = true }: {
    title: string;
    children: ReactNode;
    defaultOpen?: boolean;
}) => {
    const storageKey = `splatstudio.section.${title}`;
    const [open, setOpen] = useState(() => {
        const saved = localStorage.getItem(storageKey);
        return saved === null ? defaultOpen : saved === '1';
    });

    return (
        <div className={styles.section}>
            <button
                className={styles.header}
                aria-expanded={open}
                onClick={() => {
                    setOpen(!open);
                    localStorage.setItem(storageKey, open ? '0' : '1');
                }}
            >
                <span className={styles.chevron}>{open ? '▼' : '▶'}</span>
                {title}
            </button>
            {open && <div className={styles.body}>{children}</div>}
        </div>
    );
};

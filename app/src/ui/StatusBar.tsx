import { useAppState } from '../core/store';
import { fmtBytes, fmtCount } from './fmt';
import styles from './StatusBar.module.scss';

export const StatusBar = () => {
    const { stats, fps, device } = useAppState();

    return (
        <footer className={styles.bar}>
            {stats ? (
                <>
                    <span className={styles.file}>{stats.fileName}</span>
                    <span>{fmtCount(stats.totalSplats - stats.deleted)} splats</span>
                    {stats.deleted > 0 && <span>{fmtCount(stats.deleted)} deleted</span>}
                    <span className={stats.selected > 0 ? styles.accent : ''}>
                        {fmtCount(stats.selected)} selected
                    </span>
                    <span>{fmtBytes(stats.fileSize)}</span>
                </>
            ) : (
                <span>No scene loaded</span>
            )}
            <span className={styles.spacer} />
            {device && <span>{device}</span>}
            <span className={styles.fps}>{fps} fps</span>
        </footer>
    );
};

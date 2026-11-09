import { useEffect, useState } from 'react';

import { PROJECT_ACCEPT } from '../core/file-access';
import { fileFromRecent, forgetRecent, listRecents, type RecentItem } from '../core/recents';
import { runCommand, scene } from '../core/scene-manager';
import { setState, useAppState } from '../core/store';
import { CrossIcon } from './icons';
import styles from './StartScreen.module.scss';
import { pickSplatFile, useFileDrop } from './useFileDrop';

const formatOpened = (openedAt: number) => {
    const minutes = Math.round((Date.now() - openedAt) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d`;
    return new Date(openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const StartScreen = () => {
    const { error } = useAppState();
    const { dragOver, dropProps } = useFileDrop(
        (file, handle) => scene.openAny(file, handle),
        undefined,
        (files, handles) => scene.openDropped(files, handles)
    );
    const [recents, setRecents] = useState<RecentItem[]>([]);

    useEffect(() => {
        let cancel = false;
        void listRecents().then(items => {
            if (!cancel) setRecents(items);
        });
        return () => { cancel = true; };
    }, []);

    const openRecent = async (item: RecentItem) => {
        try {
            const { file, handle } = await fileFromRecent(item.key);
            scene.openAny(file, handle);
        } catch (err) {
            setState({ error: err instanceof Error ? err.message : String(err) });
            setRecents(await listRecents());
        }
    };

    const removeRecent = async (item: RecentItem) => {
        await forgetRecent(item.key);
        setRecents(await listRecents());
    };

    return (
        <div className={styles.screen} {...dropProps}>
            <video
                className={styles.introVideo}
                src="/media/intro.mp4"
                autoPlay
                loop
                muted
                playsInline
            />
            <div className={`${styles.card} ${dragOver ? styles.dragOver : ''}`}>
                <div className={styles.brand}>
                    <h1 className={styles.title}>EiDOlON</h1>
                    <p className={styles.subtitle}>Create and edit Gaussian splats</p>
                    {recents.length > 0 && (
                        <div className={styles.recents}>
                            <p className={styles.recentLabel}>Recent</p>
                            <ul>
                                {recents.map(item => (
                                    <li key={item.key}>
                                        <button className={styles.recentOpen} onClick={() => void openRecent(item)}>
                                            <span className={styles.recentName}>{item.name}</span>
                                            <span className={styles.recentMeta}>
                                                {item.kind === 'project' ? 'Project' : 'Splat'} · {formatOpened(item.openedAt)}
                                            </span>
                                        </button>
                                        <button
                                            className={styles.recentForget}
                                            title="Remove from recent"
                                            aria-label={`Remove ${item.name} from recent`}
                                            onClick={() => void removeRecent(item)}
                                        >
                                            <CrossIcon />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>

                <div className={styles.main}>
                    <div className={styles.actions}>
                        <button
                            className={styles.primary}
                            title="Open a .splatstudio project"
                            onClick={() => pickSplatFile((file, handle) => scene.openAny(file, handle), PROJECT_ACCEPT)}
                        >
                            Open project
                        </button>
                        <button className={styles.secondary} onClick={() => pickSplatFile((file, handle) => scene.openAny(file, handle))}>
                            Open splat
                        </button>
                        <button
                            className={styles.secondary}
                            title="Reconstruct a splat from photos or a video (Training mode)"
                            onClick={() => {
                                setState({ trainingSource: 'photos' });
                                runCommand('mode.set', { mode: 'training' });
                            }}
                        >
                            Create splat
                        </button>
                    </div>

                    <p className={styles.dropHint}>
                        {dragOver ? 'Drop to open' : 'or drop a .splatstudio, .ply, .sog or .splat file'}
                    </p>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </div>
        </div>
    );
};

import { runCommand, scene } from '../core/scene-manager';
import { setState, useAppState } from '../core/store';
import styles from './StartScreen.module.scss';
import { pickSplatFile, useFileDrop } from './useFileDrop';

const openFile = (file: File) => {
    // remember for the recent list (names only; browsers can't reopen paths)
    try {
        const recent: string[] = JSON.parse(localStorage.getItem('splatstudio.recent') ?? '[]');
        localStorage.setItem('splatstudio.recent', JSON.stringify(
            [file.name, ...recent.filter(n => n !== file.name)].slice(0, 6)
        ));
    } catch { /* storage unavailable */ }
    scene.openAny(file);
};

export const StartScreen = () => {
    const { error } = useAppState();
    const { dragOver, dropProps } = useFileDrop(openFile, undefined, files => scene.openDropped(files));

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
                </div>

                <div className={styles.main}>
                    <div className={styles.actions}>
                        <button className={styles.primary} onClick={() => pickSplatFile(openFile)}>
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
                        {dragOver ? 'Drop to open' : 'or drop a .ply, .sog or .splat file anywhere'}
                    </p>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </div>
        </div>
    );
};

import { scene } from '../core/scene-manager';
import { useAppState } from '../core/store';
import { fmtBytes, fmtCount } from './fmt';
import styles from './PerfHud.module.scss';

export const PerfHud = () => {
    const { fps, stats, device } = useAppState();
    const mem = scene.memoryStats();

    const rows: [string, string][] = [
        ['FPS', String(fps)],
        ['Splats', stats ? fmtCount(stats.totalSplats) : '—'],
        ['Rendered', stats ? fmtCount(stats.totalSplats - stats.deleted - stats.filtered - stats.hidden) : '—'],
        ['Selected', stats ? fmtCount(stats.selected) : '—'],
        ['Scene', fmtBytes(mem.sceneBytes)],
        ['Edit textures', fmtBytes(mem.textureBytes)],
        ['Renderer', device ?? '—']
    ];

    return (
        <div className={styles.hud}>
            {rows.map(([k, v]) => (
                <div key={k} className={styles.row}>
                    <span>{k}</span>
                    <span className={styles.val}>{v}</span>
                </div>
            ))}
        </div>
    );
};

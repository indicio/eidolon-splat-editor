import { useState } from 'react';

import { runCommand, scene } from '../core/scene-manager';
import { PROJECT_EXTENSION } from '../core/project';
import styles from './ExportDialog.module.scss';

/** File-name prompt for saving the .splatstudio project. */
export const SaveDialog = () => {
    const [name, setName] = useState(() => scene.outputBaseName());

    const save = () => runCommand('project.save', { name });

    return (
        <div className={styles.backdrop}>
            <div className={styles.dialog}>
                <h2>Save project</h2>

                <div className={styles.nameRow}>
                    <label>File name</label>
                    <input
                        autoFocus
                        value={name}
                        onChange={e => setName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') save();
                            if (e.key === 'Escape') runCommand('project.saveClose');
                        }}
                    />
                    <span>{PROJECT_EXTENSION}</span>
                </div>

                <p className={styles.note}>
                    {scene.hasBundledSource()
                        ? 'Includes the source splat, so the project opens on its own.'
                        : 'The source splat is not available, so opening this project will ask for it.'}
                </p>

                <div className={styles.buttons}>
                    <button className={styles.primary} disabled={!name.trim()} onClick={save}>
                        Save
                    </button>
                    <button onClick={() => runCommand('project.saveClose')}>Cancel</button>
                </div>
            </div>
        </div>
    );
};

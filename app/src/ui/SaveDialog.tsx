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
                    References the source splat file; splat data is not duplicated.
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

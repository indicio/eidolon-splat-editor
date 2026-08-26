import { useEffect } from 'react';
import { useAppState } from '../core/store';
import { CreateWizard } from './CreateWizard';
import { EditorShell } from './EditorShell';
import { StartScreen } from './StartScreen';

export const App = () => {
    const { screen, mode, trainingActive } = useAppState();

    // per-mode accent palette (see global.scss body[data-mode=…] overrides)
    useEffect(() => {
        document.body.dataset.mode = mode;
    }, [mode]);

    // The editor shell (and its engine canvas) stays mounted permanently; the
    // start screen overlays it. The training workspace stays mounted while it
    // holds frames or a running job, so switching tabs mid-reconstruction
    // keeps the job alive — it's just hidden until the tab is re-entered.
    const mountTraining = mode === 'training' || trainingActive;

    return (
        <>
            <EditorShell />
            {screen === 'start' && mode !== 'training' && <StartScreen />}
            {mountTraining && (
                <div style={{ display: mode === 'training' ? undefined : 'none' }}>
                    <CreateWizard />
                </div>
            )}
        </>
    );
};

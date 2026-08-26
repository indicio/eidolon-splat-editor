import { WebPCodec, WorkerQueue } from '@playcanvas/splat-transform';
import splatWorkerUrl from '@playcanvas/splat-transform/worker?url';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './ui/App';
import './styles/global.scss';

// splat-transform runtime config: webp wasm served from public/, worker pool
// enabled with the package's shipped worker bundle (auto-sized, capped at 4)
// so PLY parsing / morton sort / SOG compression run off the main thread.
WebPCodec.wasmUrl = new URL('lib/webp/webp.wasm', document.baseURI).toString();
WorkerQueue.workerUrl = splatWorkerUrl;

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
);

// dev convenience: ?test loads the generated synthetic scene automatically
if (import.meta.env.DEV && new URLSearchParams(location.search).has('test')) {
    void (async () => {
        const { scene } = await import('./core/scene-manager');
        const blob = await (await fetch('test-scene.ply')).blob();
        scene.openFile(new File([blob], 'test-scene.ply'));
    })();
}

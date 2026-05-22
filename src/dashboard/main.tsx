import { StrictMode, useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import UserProfilePage from './UserProfilePage';
import { ThemeProvider } from './ThemeProvider';

function getHashPath(): string {
    if (typeof window === 'undefined') return '';
    const raw = window.location.hash.replace(/^#\/?/, '');
    const seg = raw.split(/[/?#]/)[0] ?? '';
    return seg.trim().toLowerCase();
}

function subscribeHash(listener: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
}

function DashboardRoot() {
    const route = useSyncExternalStore(subscribeHash, getHashPath, () => '');

    const body = useMemo(() => {
        if (route === 'profile') {
            return (
                <ThemeProvider>
                    <UserProfilePage />
                </ThemeProvider>
            );
        }
        return <App />;
    }, [route]);

    return body;
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <DashboardRoot />
    </StrictMode>
);

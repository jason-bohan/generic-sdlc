import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type { DemoMode } from '../shared/demoMode';
import { DEFAULT_DEMO_MODE } from '../shared/demoMode';
import { fetchDemoMode, putDemoMode } from './api';
import { DEMO_MODE_THEME_MAP } from './themes';
import { useTheme } from './ThemeProvider';

interface DemoModeCtx {
    mode: DemoMode;
    loading: boolean;
    setMode: (next: DemoMode) => Promise<void>;
}

const DemoModeContext = createContext<DemoModeCtx | null>(null);

export function useDemoMode(): DemoModeCtx {
    const ctx = useContext(DemoModeContext);
    if (!ctx) throw new Error('useDemoMode must be used inside <DemoModeProvider>');
    return ctx;
}

export function DemoModeProvider({ children }: { children: ReactNode }) {
    const { current, setTheme } = useTheme();
    const [mode, setModeState] = useState<DemoMode>(DEFAULT_DEMO_MODE);
    const [loading, setLoading] = useState(true);
    const prevThemeRef = useRef<string | null>(null);
    const restoring = useRef(false);

    useEffect(() => {
        fetchDemoMode()
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((body: { mode: DemoMode }) => {
                const m = body.mode;
                setModeState(m);
                const mapped = DEMO_MODE_THEME_MAP[m];
                if (mapped && mapped !== current.id) {
                    setTheme(mapped);
                }
            })
            .catch(() => { /* use default */ })
            .finally(() => setLoading(false));
    }, []);

    const setMode = useCallback(async (next: DemoMode) => {
        const prev = mode;
        const res = await putDemoMode(next);
        if (!res.ok) throw new Error(`Failed to set mode: HTTP ${res.status}`);

        setModeState(next);

        const mapped = DEMO_MODE_THEME_MAP[next];
        if (mapped) {
            if (next === 'financial') {
                prevThemeRef.current = current.id;
                setTheme(mapped);
            } else if (next === 'standard' && !restoring.current) {
                restoring.current = true;
                const restoreTo = prevThemeRef.current && prevThemeRef.current !== DEMO_MODE_THEME_MAP.financial
                    ? prevThemeRef.current
                    : DEMO_MODE_THEME_MAP.standard;
                setTheme(restoreTo);
                setTimeout(() => { restoring.current = false; }, 0);
            }
        }
    }, [mode, current.id, setTheme]);

    return (
        <DemoModeContext.Provider value={{ mode, loading, setMode }}>
            {children}
        </DemoModeContext.Provider>
    );
}
DemoModeProvider.displayName = 'DemoModeProvider';

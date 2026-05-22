import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import {
    THEMES,
    DEFAULT_THEME_ID,
    loadSavedThemeId,
    saveThemeId,
    loadColorScheme,
    saveColorScheme,
    applyThemeWithAppearance,
    type ThemeDefinition,
    type ColorScheme,
} from './themes';

interface ThemeCtx {
    current: ThemeDefinition;
    themes: ThemeDefinition[];
    setTheme: (id: string) => void;
    colorScheme: ColorScheme;
    setColorScheme: (scheme: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

export function useTheme(): ThemeCtx {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
    return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [current, setCurrent] = useState<ThemeDefinition>(() => {
        const savedId = loadSavedThemeId();
        return THEMES.find(t => t.id === savedId) ?? THEMES.find(t => t.id === DEFAULT_THEME_ID)!;
    });
    const [colorScheme, setColorSchemeState] = useState<ColorScheme>(() => loadColorScheme());

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', colorScheme);
        applyThemeWithAppearance(current, colorScheme);
    }, [current, colorScheme]);

    const setTheme = useCallback((id: string) => {
        const theme = THEMES.find(t => t.id === id);
        if (!theme) return;
        setCurrent(theme);
        saveThemeId(id);
    }, []);

    const setColorScheme = useCallback((scheme: ColorScheme) => {
        setColorSchemeState(scheme);
        saveColorScheme(scheme);
    }, []);

    return (
        <ThemeContext.Provider value={{ current, themes: THEMES, setTheme, colorScheme, setColorScheme }}>
            {children}
        </ThemeContext.Provider>
    );
}
ThemeProvider.displayName = 'ThemeProvider';

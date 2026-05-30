export interface ThemeDefinition {
    id: string;
    name: string;
    bgPrimary: string;
    bgSecondary: string;
    bgCard: string;
    bgCardHover: string;
    border: string;
    textPrimary: string;
    textSecondary: string;
    textTertiary: string;
    accent: string;
    accentDim: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    fontMono: string;
    fontSans: string;
    teakwood: string;
    seaTurtle: string;
    autumnCream: string;
    mikado: string;
    sisal: string;
    paleGold: string;
    floor: string;
    floorAccent: string;
    floorGrout: string;
    scene: {
        bg: string;
        wall: string;
        wallAccent: string;
        wallTrim: string;
        wallBase: string;
        ambientLight: string;
        pointLight: string;
        floorBase: string;
        deskSurface: string;
        mainframeCabinet: string;
        mainframeTrim: string;
        mainframeGlow: string;
        consoleSurface: string;
        consoleBase: string;
    };
}

export const FAR_OUT_THEME: ThemeDefinition = {
    id: 'far-out',
    name: 'Far Out',
    bgPrimary: '#F0EBE0',
    bgSecondary: '#E8E2D4',
    bgCard: '#F6F2E8',
    bgCardHover: '#FBF8F0',
    border: '#C4B99E',
    textPrimary: '#2C1810',
    textSecondary: '#5A3D2B',
    textTertiary: '#7A6652',
    accent: '#1A6B5A',
    accentDim: 'rgba(26, 107, 90, 0.10)',
    success: '#1A6B5A',
    warning: '#9A5B1E',
    error: '#B5432A',
    info: '#2E8B7A',
    fontMono: "'IBM Plex Mono', 'Courier New', monospace",
    fontSans: "'Playfair Display', 'Georgia', serif",
    teakwood: '#7A5230',
    seaTurtle: '#2E8B7A',
    autumnCream: '#F0EBE0',
    mikado: '#2C1810',
    sisal: '#D4CBAC',
    paleGold: '#C8A86E',
    floor: '#E8DCC8',
    floorAccent: '#A0603A',
    floorGrout: '#3E2518',
    scene: {
        bg: '#1A1510',
        wall: '#E4D6C0',
        wallAccent: '#1A6B5A',
        wallTrim: '#D4853A',
        wallBase: '#3A2210',
        ambientLight: '#FFD4A0',
        pointLight: '#FF7840',
        floorBase: '#5E5040',
        deskSurface: '#CFC0A0',
        mainframeCabinet: '#3D7A6A',
        mainframeTrim: '#D49040',
        mainframeGlow: '#00FFBA',
        consoleSurface: '#B8A070',
        consoleBase: '#806840',
    },
};

export const NICE_ADMIN_THEME: ThemeDefinition = {
    id: 'nice-admin',
    name: 'Nice Admin',
    bgPrimary: '#0F1219',
    bgSecondary: '#161B26',
    bgCard: '#1C2333',
    bgCardHover: '#232A3B',
    border: '#2A3244',
    textPrimary: '#E8ECF4',
    textSecondary: '#9AA3B8',
    textTertiary: '#7E8EAC',
    accent: '#6366F1',
    accentDim: 'rgba(99, 102, 241, 0.12)',
    success: '#22C55E',
    warning: '#F59E0B',
    error: '#EF4444',
    info: '#818CF8',
    fontMono: "'JetBrains Mono', 'SF Mono', Consolas, monospace",
    fontSans: "'Inter', system-ui, sans-serif",
    teakwood: '#818CF8',
    seaTurtle: '#6366F1',
    autumnCream: '#0F1219',
    mikado: '#E8ECF4',
    sisal: '#2A3244',
    paleGold: '#6B7A94',
    floor: '#1A2030',
    floorAccent: '#252D40',
    floorGrout: '#0A0E14',
    scene: {
        bg: '#04060C',
        wall: '#182030',
        wallAccent: '#7C7FF8',
        wallTrim: '#344058',
        wallBase: '#0C1018',
        ambientLight: '#A0A8D8',
        pointLight: '#7880B8',
        floorBase: '#0E1420',
        deskSurface: '#1E2840',
        mainframeCabinet: '#283858',
        mainframeTrim: '#4A5878',
        mainframeGlow: '#A0AAFF',
        consoleSurface: '#283448',
        consoleBase: '#182030',
    },
};

export const SIMPLE_THEME: ThemeDefinition = {
    id: 'simple',
    name: 'Simple',
    bgPrimary: '#F7F8FC',
    bgSecondary: '#FFFFFF',
    bgCard: '#FFFFFF',
    bgCardHover: '#F0F1F8',
    border: '#E0E2EE',
    textPrimary: '#1A1D26',
    textSecondary: '#3D4455',
    textTertiary: '#5C6175',
    accent: '#7C3AED',
    accentDim: 'rgba(124, 58, 237, 0.08)',
    success: '#0D9488',
    warning: '#B45309',
    error: '#DC2626',
    info: '#0284C7',
    fontMono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSans: "'Inter', 'SF Pro Display', system-ui, sans-serif",
    teakwood: '#7C3AED',
    seaTurtle: '#0284C7',
    autumnCream: '#F7F8FC',
    mikado: '#1A1D26',
    sisal: '#E0E2EE',
    paleGold: '#5C6175',
    floor: '#F0F1F8',
    floorAccent: '#E0E2EE',
    floorGrout: '#C4C6D4',
    scene: {
        bg: '#EDEDF8',
        wall: '#F6F6FF',
        wallAccent: '#8B5CF6',
        wallTrim: '#D0D0E8',
        wallBase: '#B0B0CC',
        ambientLight: '#EEE0FF',
        pointLight: '#E0D0FF',
        floorBase: '#DCDCE8',
        deskSurface: '#F0F0FE',
        mainframeCabinet: '#E4E4F4',
        mainframeTrim: '#C0C0DA',
        mainframeGlow: '#9B6EFF',
        consoleSurface: '#ECECFC',
        consoleBase: '#DADAEA',
    },
};

export const ROCK_AND_ROLL_THEME: ThemeDefinition = {
    id: 'rock-and-roll-mcdonalds',
    name: "Rock and Roll McDonald's",
    bgPrimary: '#1A1114',
    bgSecondary: '#221518',
    bgCard: '#2A1C20',
    bgCardHover: '#352428',
    border: '#3D2830',
    textPrimary: '#F5E6D0',
    textSecondary: '#C4A882',
    textTertiary: '#9A8878',
    accent: '#FFC72C',
    accentDim: 'rgba(255, 199, 44, 0.12)',
    success: '#39FF14',
    warning: '#FF6B1A',
    error: '#DA291C',
    info: '#FF1493',
    fontMono: "'JetBrains Mono', 'Fira Code', monospace",
    fontSans: "'Bebas Neue', 'Impact', system-ui, sans-serif",
    teakwood: '#C0C0C0',
    seaTurtle: '#39FF14',
    autumnCream: '#1A1114',
    mikado: '#F5E6D0',
    sisal: '#3D2830',
    paleGold: '#FFC72C',
    floor: '#DA291C',
    floorAccent: '#FFC72C',
    floorGrout: '#1A0A0A',
    scene: {
        bg: '#080204',
        wall: '#4C1828',
        wallAccent: '#FFD040',
        wallTrim: '#D8D8D8',
        wallBase: '#100204',
        ambientLight: '#FF6680',
        pointLight: '#FFE040',
        floorBase: '#140606',
        deskSurface: '#D0D0D0',
        mainframeCabinet: '#E8241A',
        mainframeTrim: '#FFD040',
        mainframeGlow: '#44FF22',
        consoleSurface: '#C0C0C0',
        consoleBase: '#484848',
    },
};

export const LUMON_THEME: ThemeDefinition = {
    id: 'lumon',
    name: 'Lumon Industries',
    bgPrimary: '#F2F0EB',
    bgSecondary: '#E8E6E0',
    bgCard: '#FAFAF8',
    bgCardHover: '#F0EEEA',
    border: '#D4D0C8',
    textPrimary: '#1C1C1C',
    textSecondary: '#4A4A4A',
    textTertiary: '#6E6E6E',
    accent: '#8FA89C',
    accentDim: 'rgba(143, 168, 156, 0.10)',
    success: '#6B8F71',
    warning: '#A68B2C',
    error: '#A04040',
    info: '#7090A0',
    fontMono: "'IBM Plex Mono', 'Courier New', monospace",
    fontSans: "'Helvetica Neue', 'Arial', system-ui, sans-serif",
    teakwood: '#8FA89C',
    seaTurtle: '#7090A0',
    autumnCream: '#F2F0EB',
    mikado: '#1C1C1C',
    sisal: '#D4D0C8',
    paleGold: '#6E6E6E',
    floor: '#4A7A5C',
    floorAccent: '#3D6B4E',
    floorGrout: '#2E5A40',
    scene: {
        bg: '#D8D8D4',
        wall: '#F2F0EB',
        wallAccent: '#8FA89C',
        wallTrim: '#D4D0C8',
        wallBase: '#C8C4BC',
        ambientLight: '#F0F0F0',
        pointLight: '#E8ECF0',
        floorBase: '#3A6B4C',
        deskSurface: '#E0DDD6',
        mainframeCabinet: '#D0CEC8',
        mainframeTrim: '#B8B4AC',
        mainframeGlow: '#8FA89C',
        consoleSurface: '#DCDAD4',
        consoleBase: '#C0BEB8',
    },
};

export const KEYBANK_THEME: ThemeDefinition = {
    id: 'keybank',
    name: 'KeyBank',
    bgPrimary: '#F4F4F6',
    bgSecondary: '#FFFFFF',
    bgCard: '#FFFFFF',
    bgCardHover: '#F8F8FA',
    border: '#D4D4D8',
    textPrimary: '#1C1C1E',
    textSecondary: '#48484A',
    textTertiary: '#6E6E72',
    accent: '#CC0000',
    accentDim: 'rgba(204, 0, 0, 0.10)',
    success: '#003366',
    warning: '#CC6600',
    error: '#CC0000',
    info: '#003366',
    fontMono: "'IBM Plex Mono', 'Courier New', monospace",
    fontSans: "'IBM Plex Sans', 'Helvetica Neue', system-ui, sans-serif",
    teakwood: '#003366',
    seaTurtle: '#CC0000',
    autumnCream: '#F4F4F6',
    mikado: '#1C1C1E',
    sisal: '#D4D4D8',
    paleGold: '#6E6E72',
    floor: '#CC0000',
    floorAccent: '#003366',
    floorGrout: '#1C1C1E',
    scene: {
        bg: '#1A1A20',
        wall: '#FFFFFF',
        wallAccent: '#CC0000',
        wallTrim: '#003366',
        wallBase: '#F4F4F6',
        ambientLight: '#FFE0E0',
        pointLight: '#FFD0D0',
        floorBase: '#F4F4F6',
        deskSurface: '#FFFFFF',
        mainframeCabinet: '#CC0000',
        mainframeTrim: '#003366',
        mainframeGlow: '#CC0000',
        consoleSurface: '#FFFFFF',
        consoleBase: '#F4F4F6',
    },
};

export const THEMES: ThemeDefinition[] = [FAR_OUT_THEME, NICE_ADMIN_THEME, SIMPLE_THEME, ROCK_AND_ROLL_THEME, LUMON_THEME, KEYBANK_THEME];

/** Default dashboard palette when none is saved (Simple Floor 2D view). */
export const DEFAULT_THEME_ID = SIMPLE_THEME.id;

/** Map each demo mode to a recommended theme ID. */
export const DEMO_MODE_THEME_MAP: Record<string, string> = {
    standard: SIMPLE_THEME.id,
    financial: KEYBANK_THEME.id,
};

const VAR_MAP: Record<keyof Omit<ThemeDefinition, 'id' | 'name' | 'scene'>, string> = {
    bgPrimary: '--bg-primary',
    bgSecondary: '--bg-secondary',
    bgCard: '--bg-card',
    bgCardHover: '--bg-card-hover',
    border: '--border',
    textPrimary: '--text-primary',
    textSecondary: '--text-secondary',
    textTertiary: '--text-tertiary',
    accent: '--accent',
    accentDim: '--accent-dim',
    success: '--success',
    warning: '--warning',
    error: '--error',
    info: '--info',
    fontMono: '--font-mono',
    fontSans: '--font-sans',
    teakwood: '--teakwood',
    seaTurtle: '--sea-turtle',
    autumnCream: '--autumn-cream',
    mikado: '--mikado',
    sisal: '--sisal',
    paleGold: '--pale-gold',
    floor: '--floor',
    floorAccent: '--floor-accent',
    floorGrout: '--floor-grout',
};

export function applyTheme(theme: ThemeDefinition) {
    const root = document.documentElement;
    for (const [key, cssVar] of Object.entries(VAR_MAP)) {
        const val = theme[key as keyof ThemeDefinition];
        if (typeof val === 'string') {
            root.style.setProperty(cssVar, val);
        }
    }
}

/** Dashboard palette preset (Far Out, Simple, etc.) */
export const PALETTE_STORAGE_KEY = 'sdlc-framework-theme-palette';
/** Light / dark appearance; migrated from legacy use where this key stored a palette id */
const COLOR_SCHEME_STORAGE_KEY = 'sdlc-framework-theme';

const VALID_THEME_IDS = new Set(THEMES.map((t) => t.id));

export function loadSavedThemeId(): string {
    try {
        const palette = localStorage.getItem(PALETTE_STORAGE_KEY);
        if (palette && VALID_THEME_IDS.has(palette)) return palette;
        const legacy = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
        if (legacy && VALID_THEME_IDS.has(legacy)) {
            localStorage.setItem(PALETTE_STORAGE_KEY, legacy);
            return legacy;
        }
        return DEFAULT_THEME_ID;
    } catch {
        return DEFAULT_THEME_ID;
    }
}

export function saveThemeId(id: string) {
    try {
        localStorage.setItem(PALETTE_STORAGE_KEY, id);
    } catch { /* noop */ }
}

export type ColorScheme = 'light' | 'dark';

export function loadColorScheme(): ColorScheme {
    try {
        const raw = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
        if (raw === 'dark' || raw === 'light') return raw;
        if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
        return 'light';
    } catch {
        return 'light';
    }
}

export function saveColorScheme(scheme: ColorScheme) {
    try {
        localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, scheme);
    } catch { /* noop */ }
}

/** Dark mode reuses Nice Admin surfaces; keeps accent/status hues from the selected palette. */
export function applyThemeWithAppearance(theme: ThemeDefinition, appearance: ColorScheme) {
    if (appearance === 'light') {
        applyTheme(theme);
        return;
    }
    const dark = NICE_ADMIN_THEME;
    const merged: ThemeDefinition = {
        ...dark,
        id: theme.id,
        name: theme.name,
        accent: theme.accent,
        accentDim: theme.accentDim,
        success: theme.success,
        warning: theme.warning,
        error: theme.error,
        info: theme.info,
    };
    applyTheme(merged);
}

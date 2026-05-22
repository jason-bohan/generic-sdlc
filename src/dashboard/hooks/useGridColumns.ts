import { useState, useEffect } from 'react';

export function useGridColumns(): number {
    const [cols, setCols] = useState(() => {
        if (typeof window === 'undefined') return 3;
        if (window.innerWidth < 800) return 1;
        if (window.innerWidth < 1200) return 2;
        return 3;
    });

    useEffect(() => {
        function update() {
            const w = window.innerWidth;
            setCols(w < 800 ? 1 : w < 1200 ? 2 : 3);
        }
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);

    return cols;
}

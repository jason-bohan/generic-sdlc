import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
    useEffect(() => {
        if (!active) return;
        const container = ref.current;
        if (!container) return;

        const previouslyFocused = document.activeElement as HTMLElement | null;

        const focusables = () =>
            Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
                (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
            );

        const first = focusables()[0];
        first?.focus();

        function handleKeyDown(e: KeyboardEvent) {
            if (e.key !== 'Tab') return;
            const els = focusables();
            if (els.length === 0) return;
            const firstEl = els[0];
            const lastEl = els[els.length - 1];
            if (e.shiftKey) {
                if (document.activeElement === firstEl) {
                    e.preventDefault();
                    lastEl.focus();
                }
            } else {
                if (document.activeElement === lastEl) {
                    e.preventDefault();
                    firstEl.focus();
                }
            }
        }

        container.addEventListener('keydown', handleKeyDown);
        return () => {
            container.removeEventListener('keydown', handleKeyDown);
            previouslyFocused?.focus();
        };
    }, [ref, active]);
}

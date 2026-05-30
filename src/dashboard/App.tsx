import { RouterProvider } from '@tanstack/react-router';
import { ThemeProvider } from './ThemeProvider';
import { DemoModeProvider } from './DemoModeProvider';
import { router } from './router';

export default function App() {
    return (
        <ThemeProvider>
            <DemoModeProvider>
                <RouterProvider router={router} />
            </DemoModeProvider>
        </ThemeProvider>
    );
}

App.displayName = 'App';

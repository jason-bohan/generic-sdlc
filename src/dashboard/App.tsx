import { RouterProvider } from '@tanstack/react-router';
import { ThemeProvider } from './ThemeProvider';
import { router } from './router';

export default function App() {
    return (
        <ThemeProvider>
            <RouterProvider router={router} />
        </ThemeProvider>
    );
}

App.displayName = 'App';

import { useNavigate } from '@tanstack/react-router';
import { ExecDashboard } from '../ExecDashboard';

export function AnalyticsRoute() {
    const navigate = useNavigate();
    return <ExecDashboard onBack={() => void navigate({ to: '/' })} />;
}

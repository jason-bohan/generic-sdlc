import type { Handler } from '../router';

export type UseFn = (path: string, handler: Handler) => void;

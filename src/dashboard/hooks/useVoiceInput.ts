import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type SpeechRecognitionEventLike = {
    results: {
        length: number;
        [index: number]: {
            isFinal?: boolean;
            [index: number]: { transcript?: string };
        };
    };
};

type SpeechRecognitionErrorLike = { error?: string };

type SpeechRecognitionLike = {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort?: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type AudioContextCtor = new () => AudioContext;
const SILENCE_TIMEOUT_MS = 5_000;
const RESTART_DELAY_MS = 250;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    if (typeof window === 'undefined') return null;
    const w = window as typeof window & {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function getAudioContextCtor(): AudioContextCtor | null {
    if (typeof window === 'undefined') return null;
    const w = window as typeof window & {
        webkitAudioContext?: AudioContextCtor;
    };
    return window.AudioContext ?? w.webkitAudioContext ?? null;
}

function playVoiceCue(kind: 'start' | 'stop' | 'error') {
    const AudioCtor = getAudioContextCtor();
    if (!AudioCtor) return;
    try {
        const audio = new AudioCtor();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const now = audio.currentTime;
        const frequency = kind === 'start' ? 880 : kind === 'stop' ? 520 : 220;
        const duration = kind === 'error' ? 0.18 : 0.11;

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(now);
        oscillator.stop(now + duration);
        window.setTimeout(() => void audio.close().catch(() => {}), Math.ceil((duration + 0.05) * 1000));
    } catch {
        // Audio cues are non-critical and can be blocked by browser policy.
    }
}

export function mergeTranscript(current: string, transcript: string): string {
    const clean = transcript.trim();
    if (!clean) return current;
    const prefix = current.trimEnd();
    return prefix ? `${prefix} ${clean}` : clean;
}

export function useVoiceInput(onTranscript: (text: string) => void) {
    const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
    const desiredListeningRef = useRef(false);
    const silenceTimerRef = useRef<number | null>(null);
    const [listening, setListening] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const supported = useMemo(() => getSpeechRecognitionCtor() != null, []);

    useEffect(() => {
        return () => {
            desiredListeningRef.current = false;
            if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
            recognitionRef.current?.abort?.();
            recognitionRef.current = null;
        };
    }, []);

    const stop = useCallback(() => {
        desiredListeningRef.current = false;
        if (silenceTimerRef.current) {
            window.clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        recognitionRef.current?.stop();
        setListening(false);
    }, []);

    const resetSilenceTimer = useCallback(() => {
        if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = window.setTimeout(() => {
            stop();
        }, SILENCE_TIMEOUT_MS);
    }, [stop]);

    const toggle = useCallback(() => {
        if (listening) {
            stop();
            return;
        }

        const Recognition = getSpeechRecognitionCtor();
        if (!Recognition) {
            setError('Voice input is not supported in this browser.');
            return;
        }

        const recognition = new Recognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';
        let lastEmitted = '';
        recognition.onresult = (event) => {
            let full = '';
            for (let i = 0; i < event.results.length; i += 1) {
                full += event.results[i]?.[0]?.transcript ?? '';
            }
            const transcript = full.trim();
            if (transcript && transcript !== lastEmitted) {
                lastEmitted = transcript;
                resetSilenceTimer();
                onTranscript(transcript);
            }
        };
        recognition.onerror = (event) => {
            if (event.error === 'no-speech' && desiredListeningRef.current) {
                setError(null);
                return;
            }
            desiredListeningRef.current = false;
            if (silenceTimerRef.current) {
                window.clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = null;
            }
            playVoiceCue('error');
            setError(event.error ? `Voice input stopped: ${event.error}` : 'Voice input stopped.');
            setListening(false);
        };
        recognition.onend = () => {
            if (desiredListeningRef.current) {
                window.setTimeout(() => {
                    if (!desiredListeningRef.current) return;
                    try {
                        recognition.start();
                    } catch {
                        if (desiredListeningRef.current) {
                            recognition.onend?.();
                        }
                    }
                }, RESTART_DELAY_MS);
                return;
            }
            playVoiceCue('stop');
            setListening(false);
        };
        recognitionRef.current = recognition;

        try {
            setError(null);
            desiredListeningRef.current = true;
            recognition.start();
            resetSilenceTimer();
            playVoiceCue('start');
            setListening(true);
        } catch (e) {
            desiredListeningRef.current = false;
            if (silenceTimerRef.current) {
                window.clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = null;
            }
            setError(e instanceof Error ? e.message : 'Could not start voice input.');
            setListening(false);
        }
    }, [listening, onTranscript, resetSilenceTimer, stop]);

    return { supported, listening, error, toggle, stop };
}

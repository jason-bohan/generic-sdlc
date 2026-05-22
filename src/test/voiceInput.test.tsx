import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ChatPanel from '../dashboard/ChatPanel';
import HelpChat from '../dashboard/HelpChat';
import type { AgentProfile } from '../dashboard/types';

type ResultHandler = (event: { results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void;

class FakeSpeechRecognition {
    static instances: FakeSpeechRecognition[] = [];
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: ResultHandler | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn(() => this.onend?.());
    abort = vi.fn();

    constructor() {
        FakeSpeechRecognition.instances.push(this);
    }

    emit(transcript: string, isFinal = true) {
        this.onresult?.({ results: [{ isFinal, 0: { transcript } }] });
    }
}

class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    currentTime = 0;
    destination = {};
    oscillator = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
    };
    gain = {
        gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
    };
    close = vi.fn(() => Promise.resolve());

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    createOscillator() {
        return this.oscillator;
    }

    createGain() {
        return this.gain;
    }
}

const agent: AgentProfile = {
    id: 'frontend',
    name: 'Lasair',
    shortName: 'Lasair',
    role: 'frontend',
    title: 'Frontend Engineer',
    accentColor: '#6366f1',
    statusFile: '.frontend-status.json',
    active: true,
    avatar: 'F',
};

describe('voice input', () => {
    beforeEach(() => {
        FakeSpeechRecognition.instances = [];
        FakeAudioContext.instances = [];
        Element.prototype.scrollIntoView = vi.fn();
        Object.defineProperty(window, 'webkitSpeechRecognition', {
            value: FakeSpeechRecognition,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(window, 'AudioContext', {
            value: FakeAudioContext,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(window.navigator, 'language', {
            value: 'en-US',
            configurable: true,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        (window as any).webkitSpeechRecognition = undefined;
        (window as any).AudioContext = undefined;
    });

    it('fills the /btw chat input from microphone transcription', () => {
        render(<ChatPanel agent={agent} messages={[]} onSend={() => {}} onClose={() => {}} />);

        fireEvent.click(screen.getByLabelText('Start voice input'));
        act(() => FakeSpeechRecognition.instances[0].emit('please check the login form'));

        expect(screen.getByPlaceholderText('Message Lasair...')).toHaveValue('please check the login form');
        expect(FakeAudioContext.instances[0].oscillator.start).toHaveBeenCalled();
    });

    it('plays a second cue when voice input stops', () => {
        render(<ChatPanel agent={agent} messages={[]} onSend={() => {}} onClose={() => {}} />);

        fireEvent.click(screen.getByLabelText('Start voice input'));
        fireEvent.click(screen.getByLabelText('Stop voice input'));

        expect(FakeAudioContext.instances.length).toBeGreaterThanOrEqual(2);
        expect(FakeAudioContext.instances[1].oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(520, 0);
    });

    it('keeps the mic toggle active when recognition naturally ends', () => {
        render(<ChatPanel agent={agent} messages={[]} onSend={() => {}} onClose={() => {}} />);

        fireEvent.click(screen.getByLabelText('Start voice input'));
        act(() => FakeSpeechRecognition.instances[0].onend?.());

        expect(screen.getByLabelText('Stop voice input')).toBeDefined();
        expect(FakeAudioContext.instances).toHaveLength(1);
    });

    it('keeps the mic tinted while retrying a failed recognition restart', () => {
        vi.useFakeTimers();
        render(<ChatPanel agent={agent} messages={[]} onSend={() => {}} onClose={() => {}} />);

        fireEvent.click(screen.getByLabelText('Start voice input'));
        const voiceButton = screen.getByLabelText('Stop voice input');
        FakeSpeechRecognition.instances[0].start.mockImplementationOnce(() => {
            throw new Error('restart too soon');
        });

        act(() => FakeSpeechRecognition.instances[0].onend?.());
        act(() => vi.advanceTimersByTime(250));

        expect(voiceButton).toHaveStyle({ background: 'rgba(239, 68, 68, 0.14)' });
        expect(screen.getByLabelText('Stop voice input')).toBeDefined();
        vi.useRealTimers();
    });

    it('turns voice input off after five seconds of silence', () => {
        vi.useFakeTimers();
        render(<ChatPanel agent={agent} messages={[]} onSend={() => {}} onClose={() => {}} />);

        fireEvent.click(screen.getByLabelText('Start voice input'));
        expect(screen.getByLabelText('Stop voice input')).toBeDefined();

        act(() => vi.advanceTimersByTime(5_000));

        expect(screen.getByLabelText('Start voice input')).toBeDefined();
        expect(FakeSpeechRecognition.instances[0].stop).toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('fills the knowledge-base chat input from microphone transcription', () => {
        vi.stubGlobal('fetch', vi.fn());
        render(<HelpChat />);

        fireEvent.click(screen.getByLabelText('Open SDLC Framework help'));
        fireEvent.click(screen.getByLabelText('Start voice input'));
        act(() => FakeSpeechRecognition.instances[0].emit('how do I enable mock mode'));

        expect(screen.getByLabelText('Help question')).toHaveValue('how do I enable mock mode');
    });
});

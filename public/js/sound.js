'use strict';
// Synthesized sound effects (no audio files to load/host) and haptic
// vibration, both gated by the user's saved settings.

import { settings } from './storage.js';

export const vibrationSupported = typeof navigator !== 'undefined' && 'vibrate' in navigator;

let audioCtx = null;
function ensureAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function playTone({ freqStart, freqEnd, duration, type = 'sine', volume = 0.25, delay = 0 }) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, t0);
  if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

function playNoiseBurst({ duration = 0.3, volume = 0.3, filterFreq = 1000, filterType = 'lowpass', delay = 0 }) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(t0);
  noise.stop(t0 + duration + 0.03);
}

function playSound(fn) {
  if (!settings.sound) return;
  try {
    fn();
  } catch {
    /* audio can fail silently (autoplay policy etc.) — never break gameplay */
  }
}

export const sfx = {
  fire: () =>
    playSound(() => {
      playTone({ freqStart: 950, freqEnd: 180, duration: 0.14, type: 'sawtooth', volume: 0.18 });
      playNoiseBurst({ duration: 0.08, volume: 0.12, filterFreq: 2500, filterType: 'highpass' });
    }),
  miss: () =>
    playSound(() => {
      playNoiseBurst({ duration: 0.22, volume: 0.16, filterFreq: 1400, filterType: 'bandpass' });
      playTone({ freqStart: 500, freqEnd: 140, duration: 0.15, type: 'sine', volume: 0.1 });
    }),
  hit: () =>
    playSound(() => {
      playNoiseBurst({ duration: 0.32, volume: 0.32, filterFreq: 700, filterType: 'lowpass' });
      playTone({ freqStart: 160, freqEnd: 35, duration: 0.28, type: 'sine', volume: 0.28 });
    }),
  hitOnMe: () =>
    playSound(() => {
      playNoiseBurst({ duration: 0.3, volume: 0.3, filterFreq: 550, filterType: 'lowpass' });
      playTone({ freqStart: 130, freqEnd: 30, duration: 0.3, type: 'sine', volume: 0.3 });
    }),
  sunk: () =>
    playSound(() => {
      playNoiseBurst({ duration: 0.4, volume: 0.36, filterFreq: 500, filterType: 'lowpass' });
      playTone({ freqStart: 180, freqEnd: 30, duration: 0.35, type: 'sine', volume: 0.32 });
      playNoiseBurst({ duration: 0.35, volume: 0.28, filterFreq: 350, filterType: 'lowpass', delay: 0.12 });
      playTone({ freqStart: 300, freqEnd: 50, duration: 0.5, type: 'triangle', volume: 0.16, delay: 0.15 });
    }),
  win: () =>
    playSound(() => {
      [523, 659, 784, 1047].forEach((f, i) => {
        playTone({ freqStart: f, duration: 0.22, type: 'triangle', volume: 0.22, delay: i * 0.11 });
      });
    }),
  lose: () =>
    playSound(() => {
      [392, 349, 294, 220].forEach((f, i) => {
        playTone({ freqStart: f, freqEnd: f * 0.9, duration: 0.32, type: 'sawtooth', volume: 0.18, delay: i * 0.16 });
      });
    }),
};

/** @param {number|number[]} pattern */
export function vibrate(pattern) {
  if (!settings.vibration || !vibrationSupported) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

import { MathUtils } from 'three';

export interface IdleAnimationState {
  bobOffset: number;
  armSwing: number;
  headTilt: number;
}

export interface ActiveAnimationState {
  typingSpeed: number;
  leftArmAngle: number;
  rightArmAngle: number;
}

export const ANIMATION_CONFIG = {
  idle: {
    bobSpeed: 2,
    bobAmplitude: 0.02,
    armSwingSpeed: 1.5,
    armSwingAmplitude: 0.05,
    headTiltSpeed: 0.8,
    headTiltAmplitude: 0.03,
  },
  active: {
    typingSpeed: 10,
    typingAmplitude: 0.15,
  },
} as const;

/**
 * Compute idle animation offsets for an agent avatar.
 * @param elapsedTime - elapsed seconds from useFrame clock
 * @param seed - per-agent offset (e.g. agent index) to prevent synchronized bobbing
 */
export function getIdleAnimation(elapsedTime: number, seed = 0): IdleAnimationState {
  const t = elapsedTime + seed;
  const { bobSpeed, bobAmplitude, armSwingSpeed, armSwingAmplitude, headTiltSpeed, headTiltAmplitude } = ANIMATION_CONFIG.idle;
  return {
    bobOffset: Math.sin(t * bobSpeed) * bobAmplitude,
    armSwing: Math.sin(t * armSwingSpeed) * armSwingAmplitude,
    headTilt: Math.sin(t * headTiltSpeed) * headTiltAmplitude,
  };
}

/**
 * Compute active (typing) animation angles for an agent avatar.
 * @param elapsedTime - elapsed seconds from useFrame clock
 * @param seed - per-agent offset (e.g. agent index) to vary typing rhythm
 */
export function getActiveAnimation(elapsedTime: number, seed = 0): ActiveAnimationState {
  const t = elapsedTime + seed;
  const { typingSpeed, typingAmplitude } = ANIMATION_CONFIG.active;
  return {
    typingSpeed,
    leftArmAngle: Math.sin(t * typingSpeed) * typingAmplitude,
    rightArmAngle: Math.sin(t * typingSpeed + Math.PI * 0.5) * typingAmplitude,
  };
}

export function lerpPhaseTransition(
  from: number,
  to: number,
  progress: number,
): number {
  return MathUtils.lerp(from, to, MathUtils.clamp(progress, 0, 1));
}

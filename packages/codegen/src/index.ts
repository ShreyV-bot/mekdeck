import { MekdeckError } from '@mekdeck/core';
import type { SceneDescription } from '@mekdeck/scene';
import { generateThree, type ThreeOptions } from './three.ts';
import type { GeneratedProject } from './types.ts';

export * from './code-builder.ts';
export * from './three.ts';
export * from './types.ts';

/** Targets that can be generated today. Node.js and Next.js are on the roadmap. */
export const TARGETS = ['three'] as const;
export type TargetId = (typeof TARGETS)[number];

export interface GenerateOptions extends ThreeOptions {
  readonly target: string;
}

export function generateProject(scene: SceneDescription, options: GenerateOptions): GeneratedProject {
  switch (options.target) {
    case 'three':
      return generateThree(scene, options);
    default:
      throw new MekdeckError(
        'E_TARGET_UNSUPPORTED',
        `Unknown target "${options.target}". Available targets: ${TARGETS.join(', ')}`,
      );
  }
}

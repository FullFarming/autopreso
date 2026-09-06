import { LiveMediaPipeline as ProductionPipeline } from '../../src/live-media-pipeline.js';
import { createGeminiCaptionConfig } from '../../../packages/caption-core/index.js';
import { GEMINI_ENGINE_SELECTION } from '../../../packages/caption-core/caption-engine-catalog.js';

// These fixtures exercise the serial Gemini translator. Keep that engine
// explicit so a change to new-user defaults cannot silently test Soniox.
export class LiveMediaPipeline extends ProductionPipeline {
  constructor(options) {
    super({ ...options, captionConfig: options.captionConfig ?? createGeminiCaptionConfig({ ...options, engine: GEMINI_ENGINE_SELECTION }) });
  }
}
export { evaluateCaptionPolish } from '../../src/live-media-pipeline.js';

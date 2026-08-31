import {
  countLanguageCharsFor,
  countLanguageSignalChars,
  detectSourceLanguage,
  isOutputInTargetLanguage,
  languageGateContract,
  sourceLaneMatches as sharedSourceLaneMatches,
} from "../../packages/caption-core/index.js";
import { textPlausiblyInLanguage } from "./config.js";

export {
  countLanguageCharsFor,
  countLanguageSignalChars,
  detectSourceLanguage,
  isOutputInTargetLanguage,
  languageGateContract,
};

export function sourceLaneMatches(text, sttLanguage, laneLanguage) {
  return sharedSourceLaneMatches(text, sttLanguage, laneLanguage, { textPlausiblyInLanguage });
}

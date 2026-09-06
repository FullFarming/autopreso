import { isSupportedSubtitleLanguage } from "./subtitle-languages.js";

/** Validate appearance commands at the websocket boundary without forwarding client credentials. */
export function normalizeSubtitleControllerCommand(message) {
  const command = message?.command;
  if (!["stop", "restart", "font", "font-size", "offset", "position", "languages", "opacity"].includes(command)) return null;
  const result = { type: "subtitle:control", command };
  if (command === "font" || command === "offset") {
    if (typeof message.delta !== "number" || !Number.isFinite(message.delta)) return null;
    return { ...result, delta: message.delta };
  }
  if (command === "font-size" || command === "opacity") {
    const field = command === "font-size" ? "fontSize" : "opacity";
    const value = message[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const minimum = command === "font-size" ? 18 : 0;
    const maximum = command === "font-size" ? 72 : 1;
    return { ...result, [field]: Math.max(minimum, Math.min(maximum, value)), preview: message.preview === true };
  }
  if (command === "position") {
    if (!["top-center", "middle-center", "bottom-center"].includes(message.position)) return null;
    return { ...result, position: message.position, preview: message.preview === true };
  }
  if (command === "languages") {
    if (!Array.isArray(message.languages)) return null;
    return { ...result, languages: message.languages.filter(isSupportedSubtitleLanguage) };
  }
  return result;
}

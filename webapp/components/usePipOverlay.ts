"use client";

// Always-on-top subtitle overlay via the Document Picture-in-Picture API,
// with a window.open popup fallback. Movie-style linger: the box stays after
// the last update for clamp(2000 + 60·chars, 2500, 7000) ms; partial updates
// keep it alive.

import { useCallback, useEffect, useRef, useState } from "react";

import type { PipPosition } from "@/lib/settings";

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
    };
  }
}

export interface PipOverlayOptions {
  position: PipPosition;
  fontSize: number;
  showSource: boolean;
}

export interface SubtitleUpdate {
  translatedText: string;
  sourceText: string;
  partial: boolean;
}

const POSITION_ALIGN: Record<PipPosition, string> = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
};

function lingerMs(text: string): number {
  return Math.min(7000, Math.max(2500, 2000 + 60 * text.length));
}

export function usePipOverlay(options: PipOverlayOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const windowRef = useRef<Window | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const translationRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const applyStyles = useCallback(() => {
    const { position, fontSize, showSource } = optionsRef.current;
    if (wrapRef.current) wrapRef.current.style.justifyContent = POSITION_ALIGN[position] ?? "flex-end";
    if (translationRef.current) translationRef.current.style.fontSize = `${fontSize}px`;
    if (sourceRef.current) {
      sourceRef.current.style.fontSize = `${Math.max(12, Math.round(fontSize * 0.55))}px`;
      sourceRef.current.style.display = showSource && sourceRef.current.textContent ? "block" : "none";
    }
  }, []);

  const teardown = useCallback(() => {
    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    lingerTimerRef.current = null;
    const win = windowRef.current;
    windowRef.current = null;
    boxRef.current = null;
    translationRef.current = null;
    sourceRef.current = null;
    wrapRef.current = null;
    setIsOpen(false);
    if (win && !win.closed) {
      try { win.close(); } catch { /* noop */ }
    }
  }, []);

  const buildRenderer = useCallback((win: Window) => {
    const doc = win.document;
    doc.title = "NOVA 자막";
    doc.body.innerHTML = "";
    // Cinema subtitles: near-black translucent window (black @ 35%), NO
    // box/card — just white text with a strong shadow, centered and
    // bottom-anchored, clamped to 2 lines.
    const style = doc.createElement("style");
    style.textContent = `
      html, body { margin: 0; padding: 0; height: 100%; background: rgba(0, 0, 0, 0.35); overflow: hidden; }
      * { box-sizing: border-box; }
      .wrap {
        display: flex; flex-direction: column; height: 100vh;
        padding: 8px 18px 14px;
        font-family: Pretendard, "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      }
      .box {
        align-self: center;
        max-width: 100%;
        text-align: center;
        transition: opacity 0.25s ease;
      }
      .box.hidden { opacity: 0; }
      .translation {
        color: #ffffff;
        font-weight: 700;
        line-height: 1.25;
        word-break: keep-all;
        overflow-wrap: anywhere;
        text-shadow: 0 2px 8px rgba(0, 0, 0, 0.9);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .source {
        color: rgba(255, 255, 255, 0.78);
        margin-top: 4px;
        line-height: 1.25;
        word-break: keep-all;
        overflow-wrap: anywhere;
        text-shadow: 0 2px 8px rgba(0, 0, 0, 0.9);
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
    `;
    doc.head.appendChild(style);
    const wrap = doc.createElement("div");
    wrap.className = "wrap";
    const box = doc.createElement("div");
    box.className = "box hidden";
    const translation = doc.createElement("div");
    translation.className = "translation";
    const source = doc.createElement("div");
    source.className = "source";
    box.appendChild(translation);
    box.appendChild(source);
    wrap.appendChild(box);
    doc.body.appendChild(wrap);

    windowRef.current = win;
    wrapRef.current = wrap as any;
    boxRef.current = box as any;
    translationRef.current = translation as any;
    sourceRef.current = source as any;
    applyStyles();

    win.addEventListener("pagehide", teardown);
    win.addEventListener("unload", teardown);
    setIsOpen(true);
  }, [applyStyles, teardown]);

  const openOverlay = useCallback(async () => {
    if (windowRef.current && !windowRef.current.closed) return;
    if (window.documentPictureInPicture) {
      const win = await window.documentPictureInPicture.requestWindow({ width: 900, height: 180 });
      buildRenderer(win);
      return;
    }
    // Fallback: plain popup with the same renderer (not always-on-top, but
    // can be kept over the presentation manually).
    const win = window.open("", "realtime-noel-subtitles", "width=900,height=180,resizable=yes");
    if (!win) {
      throw new Error("팝업이 차단되었습니다. 브라우저의 팝업 허용 후 다시 시도해 주세요.");
    }
    buildRenderer(win);
  }, [buildRenderer]);

  const closeOverlay = useCallback(() => {
    teardown();
  }, [teardown]);

  const pushSubtitle = useCallback((update: SubtitleUpdate) => {
    const win = windowRef.current;
    if (!win || win.closed) return;
    const box = boxRef.current;
    const translation = translationRef.current;
    const source = sourceRef.current;
    if (!box || !translation || !source) return;

    translation.textContent = update.translatedText;
    source.textContent = optionsRef.current.showSource ? update.sourceText : "";
    applyStyles();
    box.classList.remove("hidden");

    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    // Partials keep the box alive; the linger countdown only runs from the
    // most recent update (committed or partial).
    lingerTimerRef.current = setTimeout(() => {
      box.classList.add("hidden");
      lingerTimerRef.current = null;
    }, lingerMs(update.translatedText));
  }, [applyStyles]);

  // Re-style the overlay live when settings change while it is open.
  useEffect(() => {
    if (isOpen) applyStyles();
  }, [isOpen, options.position, options.fontSize, options.showSource, applyStyles]);

  // Close the overlay when the main page unloads.
  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  return { isOpen, openOverlay, closeOverlay, pushSubtitle };
}

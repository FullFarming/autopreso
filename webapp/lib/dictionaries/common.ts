import type { SystemMessages } from "../system-language";

export const commonMessages = {
  ko: { systemLanguage: "화면 언어", chooseLanguage: "화면 언어 선택", storageError: "언어를 저장하지 못했어요. 이 화면에는 선택한 언어를 적용했어요." },
  en: { systemLanguage: "Interface language", chooseLanguage: "Choose interface language", storageError: "Your language could not be saved. It is applied to this screen." },
  ja: { systemLanguage: "表示言語", chooseLanguage: "表示言語を選択", storageError: "言語を保存できませんでした。この画面には選択した言語を適用しています。" },
} satisfies SystemMessages;

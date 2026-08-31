import type { SystemMessages } from "../system-language";

export const authMessages: SystemMessages = {
  ko: {
    unavailable: "로그인 상태를 확인하지 못했어요. 연결을 확인한 뒤 다시 확인해 주세요.",
    signedOut: "로그인이 만료되었어요. 현재 화면은 유지됩니다. 다시 로그인해 주세요.",
    retry: "다시 확인", checking: "확인 중…", login: "로그인",
    logoutFailed: "로그아웃하지 못했어요. 연결을 확인한 뒤 로그아웃을 다시 눌러 주세요.",
  },
  en: {
    unavailable: "Could not check your sign-in status. Check your connection, then try again.",
    signedOut: "Your sign-in has expired. This screen will remain open. Sign in again to continue.",
    retry: "Check again", checking: "Checking…", login: "Sign in",
    logoutFailed: "Could not sign out. Check your connection, then select Sign out again.",
  },
  ja: {
    unavailable: "ログイン状態を確認できませんでした。接続を確認してから再確認してください。",
    signedOut: "ログインの有効期限が切れました。この画面は維持されます。再度ログインしてください。",
    retry: "再確認", checking: "確認中…", login: "ログイン",
    logoutFailed: "ログアウトできませんでした。接続を確認してからログアウトを再度押してください。",
  },
};

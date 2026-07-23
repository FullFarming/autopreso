import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Editorial palette (de-branded). Ink near-black, off-white canvas,
        // pastel atmospheric orbs. "red" is the iOS record affordance only.
        cw: {
          ink: "#0c0a09",
          canvas: "#f5f5f5",
          canvasSoft: "#fafafa",
          surface: "#ffffff",
          surfaceStrong: "#f0efed",
          hairline: "#e7e5e4",
          hairlineStrong: "#d6d3d1",
          primary: "#292524",
          primaryActive: "#0c0a09",
          red: "#FF453A",
          redHover: "#FF6961",
          action: "#0a84ff",
          // legacy aliases remapped onto the editorial scale so existing
          // className references keep resolving (ink/body/muted on light)
          indigo: "#101426",
          grey: "#4e4e4e",
          grey75: "#777169",
          grey50: "#a8a29e",
          grey25: "#d6d3d1",
          grey12: "#f0efed",
          blue: "#0a84ff",
          blue75: "#3b9bff",
          blue50: "#80b8f0",
          blue25: "#cfe2fb",
          blue12: "#e9f1fc",
          yellow: "#bd8b00",
          green: "#16a34a",
          darkRed: "#a32d2d",
          darkRedTint: "#fceeec",
          body: "#0c0a09",
          mint: "#a7e5d3",
          peach: "#f4c5a8",
          lavender: "#c8b8e0",
          sky: "#a8c8e8",
          rose: "#e8b8c4",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "Pretendard",
          "Noto Sans KR",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Apple SD Gothic Neo",
          "Malgun Gothic",
          "sans-serif",
        ],
        serif: ["EB Garamond", "Noto Sans KR", "serif"],
      },
      boxShadow: {
        cwModal: "0 24px 60px rgba(12,10,9,0.16)",
        cwHover: "0 6px 16px rgba(12,10,9,0.10)",
      },
    },
  },
  plugins: [],
};

export default config;

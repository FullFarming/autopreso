# Realtime Noel Subtitles Packaging

## Targets

- macOS: `Realtime Noel Subtitles-<version>-mac-<arch>.dmg`
- Windows: `Realtime Noel Subtitles-<version>-win-portable.exe`

## Commands

```bash
npm run dist:mac
npm run dist:mac:x64
npm run dist:win
```

## Notes

- The Windows target is portable, not an installer.
- `dist:win` builds the common Windows x64 portable executable.
- `dist:mac` builds Apple Silicon DMG. Use `dist:mac:x64` for Intel Mac DMG.
- Unsigned macOS builds can show a Gatekeeper warning on first launch.
- Unsigned Windows builds can show a SmartScreen warning on first launch.
- Microphone and system audio permissions are still requested by the operating system at runtime.
- Building Windows artifacts on macOS may require Wine depending on the local Electron Builder toolchain.

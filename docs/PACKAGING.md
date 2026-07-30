# NOVA Packaging

## Targets

- macOS: `NOVA-<version>-<arch>.dmg`
- Windows: `NOVA-<version>-win-portable.exe`

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
- The current macOS build uses ad-hoc signing and can show a Gatekeeper warning on first launch.
- Unsigned Windows builds can show a SmartScreen warning on first launch.
- Microphone and system audio permissions are still requested by the operating system at runtime.
- Building Windows artifacts on macOS may require Wine depending on the local Electron Builder toolchain.

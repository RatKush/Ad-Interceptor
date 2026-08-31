# Popup UI reference

Rendered from the real `popup.html` in headless Chromium at 2× — not mockups.
Regenerate with `npm run design` after any popup change. The set depends on
`config.js`: a free build omits `popup-pro.png`, because with the Pro card
hidden that shot would be identical to `popup-dark.png`.

| File | State |
|---|---|
| `popup-dark.png` | Default, dark theme |
| `popup-light.png` | Default, light theme (`prefers-color-scheme: light`) |
| `popup-pro.png` | Pro active — only generated when `PRO_ENABLED = true` |
| `popup-off.png` | Blocking off — shield greyed, glow removed, pause disabled |
| `popup-paused.png` | Current site paused — accent "Resume" button |

Two bugs were caught by looking at these rather than reasoning about the CSS:
the row title/subtitle rendering on one line (spans need `display: block`), and
the Pro licence form staying visible because `.pro-form { display: flex }`
outranks the UA `[hidden] { display: none }` rule.

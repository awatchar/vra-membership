# Brand assets

The association's logo at its original size, kept as the source these are
derived from rather than as something served directly.

| File                                | Notes                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `vra-logo-transparent-500.png`      | 500×500, transparent background. The one to derive from — it works on both the light and the dark theme. |
| `vra-logo-white-background-500.png` | 500×500, white background. Kept for print and for anywhere a solid backing is wanted.                    |

## What the client actually ships

`src/web/assets/vra-logo.png` — 192×192, 24 KB. Derived from the transparent
original with:

```bash
node scripts/resize-png.ts assets/brand/vra-logo-transparent-500.png src/web/assets/vra-logo.png 192
```

Re-run that after replacing an original, and commit the result.

192 pixels is deliberate: the logo is displayed at 40–48 CSS pixels, so this
covers a 4× display without shipping four times the bytes anyone can see. The
original is 96 KB and would have been the largest single asset on a page that
loads a 134 KB bundle, for an image rendered smaller than a thumbnail.

The script also drops the `eXIf` and `iTXt` chunks the original carries. Neither
belongs in a file served to every visitor.

# Hermod Messenger assets

The approved brand is the orange Messenger on white, based on [the selected concept](concepts/01-messenger.png).

- `icon.png`: native 1254 × 1254 production master.
- `banner.png`: native 2172 × 724 logo-and-wordmark banner, displayed at the top of the main README.
- `../../public/icon/`: PNG exports at 16, 24, 32, 48, 64, 96, 128, 180, 192, 256, 512 and 1024 pixels. Toolbar icons use 16/24/32/48; extension metadata uses 16/32/48/96/128; 180 is available for Apple touch icons and 192/512 for web app use.
- `../../public/favicon.ico`: multi-resolution 16/32/48 favicon. The settings and popup pages also declare the 16/32 PNGs.

Every size is downsampled directly from the production master, never from another small export. Page headers round the white icon tile with CSS. The toolbar activity indicator uses these same 16/32 images as its base.

To regenerate the size variants, install ImageMagick and run `npm run brand:icons`. Generated assets are checked in; ordinary builds do not require ImageMagick. The banner and master were produced with the built-in image generation tool; final raster dimensions are those returned by the tool.

## Production prompts

### Icon

```text
Use case: precise-object-edit / logo-brand. Input image: approved Hermod concept sheet, edit reference.
Extract and faithfully recreate ONLY the bottom-left white tile with the orange Messenger as one standalone production app icon, square 2048 x 2048 pixels, crisp high-resolution flat vector-like rendering.
Preserve the EXACT character identity, right-facing youthful face, helmet shape, swept-back hair, cape curves and overall silhouette of that bottom-left icon. The user has approved this symbol; do not reinterpret it or introduce a different character. Use solid brand clay orange #b6613f on a solid near-white #fdfdfc rounded-square tile, with a generous corner radius matching the reference. The tile should fill the square canvas; only the tiny area outside the rounded corners should be transparent. Character centered with balanced padding around it, occupies about 80% of tile width and 70% height, as in the reference. Preserve the orange subject and white negative space; no dark icon variant.
Remove any imagegen grain, shading, vignette and gradient, keep completely flat exact solid colors and sharp smooth contours. No text, title, concept number, other samples, watermark, drop shadow or surrounding beige board. This image is the actual icon asset.
```

### Icon cleanup

```text
Edit the attached icon into a clean production square PNG. Preserve the exact orange Messenger silhouette and placement, face, helmet, hair and cape. Change only the background: make EVERY background pixel opaque uniform near-white #fdfdfc, including the upper-left gray/transparent blemish and all outside edges. Remove the gray smudge at top left completely. No rounded tile, no transparency, no border, no shadow; a FULL BLEED SOLID WHITE SQUARE background that fills the entire image. All face/cape negative spaces must use that same near-white. The character stays brand clay orange #b6613f. Crisp flat clean contours with no grain or gradient. Square high resolution 2048 x 2048. No text or extras. This is the same approved logo, not a redesign.
```

### README banner

```text
Use case: precise-object-edit / logo-brand. Input image: approved Hermod concept sheet, edit reference.
Expand ONLY the upper large Messenger symbol + black "Hermod" wordmark lockup into a polished wide GitHub README banner, 2400 x 800 pixels, aspect ratio 3:1. One finished banner, not a presentation board.
Faithfully preserve the approved youthful right-facing Messenger, low rounded travel helmet, swept hair and cape, same profile and silhouette as the input. Keep the recognizable face; no redesign. Retain the large elegant bold serif "Hermod" wordmark from the upper lockup, spelled EXACTLY "Hermod". The symbol sits left and the wordmark to its right, balanced together, vertically centered with spacious padding and no cropped edges.
Palette: flat clay #b6613f Messenger, charcoal #1e1e1c wordmark, uniform near-white #fdfdfc backdrop. Crisp high-resolution smooth vector-like contours. No gradient, paper grain, shadow, texture or decorative imagery. Match the warm editorial confidence of the reference. Use the banner's wide format to give the lockup breathing room while keeping it prominent.
Exact text only: "Hermod". Remove "01 / THE MESSENGER", all three lower app icon examples, grid dividers and concept-board annotations. No slogan, subtitle or extra text.
```

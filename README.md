# Suno Tampermonkey Batch Exporter

This project contains a conservative Tampermonkey userscript for exporting songs from your own authenticated Suno Library or Workspace, plus a local Node.js post-processor for reliable ID3 metadata writing.

## Architecture

- `suno-batch-export.user.js` runs only on Suno pages, adds a persistent `Suno Batch Export` launcher button below Suno's top-right Audio controls, and warns when the current page does not look like a Library or Workspace route.
- The userscript scans visible song cards, can auto-scroll the library with `Scan all`, supports multi-select in its panel, can queue any number of detected songs, can select a download folder in Chromium browsers, and can toggle a page-level multi-select mode for clicking detected Suno cards directly.
- Duplicate MP3 protection uses Tampermonkey storage key `suno_downloaded_tracks_v1`; duplicate checking happens in `exportSong()` before MP3 fetch/embed work and in `downloadTrackSafely()` immediately before `GM_download`.
- It extracts only visible or already-authorized data from the page.
- MP3 export uses a visible authorized media URL when Suno exposes one. If that is unavailable, Individual mode can click a visible official Suno download button, but ZIP mode cannot embed an MP3 it cannot safely fetch and will explain that before export in Dry run.
- The browser path writes ID3v2.4 frames directly for `TIT2`, `TPE1`, `USLT`, `APIC`, and `TXXX` custom metadata.
- `tools/postprocess-id3.cjs` is the fallback for files downloaded manually through Suno. It pairs exported metadata JSON, lyrics TXT, cover images, and MP3 files, then writes tags locally with `node-id3`.

## Files

- `suno-batch-export.user.js`: complete Tampermonkey userscript.
- `tools/postprocess-id3.cjs`: optional local ID3 post-processor.
- `package.json`: Node dependency and validation scripts.

## Tampermonkey Install

Direct install URL:

https://raw.githubusercontent.com/emmanueltremblay9-stack/Suno-Download-It-All-Remember/main/suno-batch-export.user.js

Clicking that raw `.user.js` URL should open Tampermonkey's install screen. Do not use the normal GitHub file preview page as the installer URL.

1. Install Tampermonkey in Chrome or Edge.
2. Open the direct install URL above.
3. Confirm `Install` in Tampermonkey.
4. Open your authenticated Suno Library or Workspace page.

Manual fallback:

1. Open Tampermonkey Dashboard.
2. Create a new userscript.
3. Paste the full contents of `suno-batch-export.user.js`.
4. Save it.

The script requires JSZip from jsDelivr for ZIP creation. No analytics, remote logging, credential collection, or token export is included.

## Usage

1. Open your own Suno Library or Workspace page.
2. Use Suno's UI to select songs if selection is available, or leave songs visible on the page.
3. Click the `Suno Batch Export` button on the Suno page to open the download menu.
4. Click `Scan all` to auto-scroll the library and accumulate the full rendered queue, or click `Scan visible` to add only the currently rendered songs.
5. Review the detected queue. New detected songs are selected by default; use `Select all`, the `all queued` checkbox, individual checkboxes, or Shift-click to adjust a range.
6. Optional: enable `multi-select` and click detected song cards on the Suno page to toggle them without using Suno's own selection UI.
7. Run `Dry run` first to confirm metadata and MP3 availability.
8. Choose ZIP or individual export.
9. Optional: click `Select folder` between `Export` and `Retry failed` to choose a download folder. Chrome and Edge can write exports there directly; other browsers use the normal download folder.
10. Click `Export` and confirm the queue operation. The exporter processes the queue sequentially with throttling and does not impose a fixed item limit. Completed MP3s are recorded only after `GM_download` succeeds or the selected-folder file write succeeds.

For the most reliable metadata result, export ZIP sidecars, manually download any MP3s that Suno does not expose as authorized media URLs, extract everything to one folder, then run the Node post-processor.

## Local Post-Processor

Install dependencies from this project folder:

```powershell
pnpm install
```

If `pnpm` is not on PATH, use the bundled Codex pnpm path or any local Node package manager.

Run against an extracted export folder:

```powershell
node tools/postprocess-id3.cjs --input "C:\Path\To\Suno Export" --output "C:\Path\To\Tagged"
```

Overwrite matching MP3s in place:

```powershell
node tools/postprocess-id3.cjs --input "C:\Path\To\Suno Export" --overwrite
```

Preview matching without writing:

```powershell
node tools/postprocess-id3.cjs --input "C:\Path\To\Suno Export" --dry-run
```

## Troubleshooting

- Install page does not open: use the raw URL above, not `github.com/.../blob/...`. If the browser only shows text, copy the raw URL and paste it into Tampermonkey Dashboard's import/install-from-URL field, or use the manual fallback.
- No `Suno Batch Export` button appears: verify Tampermonkey is enabled, the script version is `0.1.11` or newer, and the page URL matches `suno.com`, a Suno subdomain, or `app.suno.ai`.
- `Select folder` is disabled: the browser or userscript manager does not expose `window.showDirectoryPicker()` to userscripts. Use current Chrome or Edge with current Tampermonkey, or let the browser save to its default download folder.
- Export controls disabled: open a Suno page. The script matches `suno.com`, Suno subdomains, and `suno.ai` subdomains.
- No songs detected: scroll the library so song cards or song links are visible, then click `Scan visible`. Version `0.1.11` also adds `Scan all`, falls back to plain visible Suno song, clip, track, and MP3 links, accumulates scans into the queue, and does not cap the detected queue.
- Multi-select clicks open the song instead of selecting it: confirm the `multi-select` checkbox is enabled in the exporter panel and scan again.
- Missing MP3 in ZIP mode: Suno did not expose a safe authorized MP3 URL in the visible page. Use Suno's official download button, then run the local post-processor.
- Missing lyrics, prompt, style, or date: Suno did not render those fields in the visible card. Open expanded song details if Suno provides them, then scan again.
- ID3 tags not visible in a player: try the Node post-processor. Some players handle browser-written ID3v2.4 tags inconsistently.
- Network errors: keep the default delay or increase it, and retry failed items. Very large ZIP exports may hit browser memory limits; individual mode is safer for huge queues.
- Duplicate unexpectedly skipped: use the Tampermonkey menu item `Export Suno Download History` to inspect saved keys, or `Reset Suno Download History` to clear them.

## Website Change Risks

These parts can break if Suno changes the site:

- DOM card detection selectors and accessible labels.
- Visible selected-state detection.
- Location of lyrics, prompt, style, model, duration, and creation date.
- Whether an authorized MP3 URL appears in the page.
- Text or labels on Suno's official download button.

The script is designed to fail with warnings instead of guessing private endpoints or bypassing controls.

## Safety And Compliance

- The userscript only enables export controls on Suno Library or Workspace routes.
- It does not bypass login, paywalls, subscription limits, CORS, DRM, access controls, or rate limits.
- It does not invent private API endpoints.
- It does not collect credentials, tokens, cookies, analytics, or telemetry.
- It only fetches current-origin, `suno.com`, or `suno.ai` URLs.
- Queue export requires manual confirmation and uses conservative throttling. There is no built-in fixed maximum queue size.
- Duplicate history can be exported or reset from the Tampermonkey menu. Resetting history allows previously downloaded songs to be downloaded again.
- If safe MP3 access is unavailable, it tells you to use Suno's official manual download flow and then tag files locally.

## Validation

Syntax check:

```powershell
node --check suno-batch-export.user.js
node --check tools/postprocess-id3.cjs
```

Package script:

```powershell
pnpm run check
```

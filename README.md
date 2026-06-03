# Live Preview HTML ⚡

<p align="center">
  <img src="logo.png" width="128" alt="Live Preview HTML Logo">
</p>

A premium, fast, and feature-packed universal previewer for VS Code. **Live Preview HTML** allows you to open and preview HTML, Markdown, XML, CSV, PDFs, images, and videos concurrently. It supports real-time synchronization, text sandbox editors, image zooming, and custom video timeline overlays—all side-by-side inside your workspace.

---

## Key Features

- 👁️ **Simultaneous Multiple Previews**: Open and arrange multiple live previews side-by-side for different files.
- ⚡ **Real-Time Synchronisation**: Keystrokes in your HTML or saved changes in your CSS files reflect instantly in the preview with scroll-preserving hot-reload.
- 📁 **Universal File Previews**: Renders Markdown `.md` text, formatted XML documents with tag highlights, CSV/SSV comma separated tables, zoomable images, video playback controls, and native PDFs.
- 💻 **Interactive Selection Sandbox**: Select any HTML text in your editor, right-click, and choose **Live Preview HTML** to open a live split-pane sandbox (similar to JSFiddle/CodePen) with dedicated HTML, CSS, and JS inputs.
- ⚓ **VS Code Status Bar Launcher**: A dynamic launcher button (`⚡ Live Preview HTML`) appears automatically at the bottom of VS Code whenever you open supported files.

---

## Installation & Setup

### Instant Dev Testing (F5)
1. Open this folder (`c:\Users\Rupeshh\Downloads\proj vs`) in VS Code.
2. Press `F5` (or go to **Run > Start Debugging**).
3. In the new host window, open `website/index.html`.
4. Click the **`⚡ Live Preview HTML`** button in the bottom status bar (or right-click and select **Live Preview HTML**).

### Permanent Global Installation
1. Open your terminal in the extension folder:
   ```bash
   npx @vscode/vsce package
   ```
2. Install the created package in VS Code:
   ```bash
   code --install-extension htmlpreview-vscode-1.0.1.vsix
   ```

---

## Repository & Info

- **Version**: 1.0.1
- **Developer**: Rupesh9369
- **GitHub**: [https://github.com/Rupesh9369/htmlpreview-vscode](https://github.com/Rupesh9369/htmlpreview-vscode)
- **License**: MIT
- **Keywords**: vscode, html, css, preview, live preview, markdown, csv, xml, pdf, image viewer, video player, realtime, sandbox, code.

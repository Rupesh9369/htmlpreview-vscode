# Rage Live Preview ⚡

A premium, feature-packed VS Code extension designed for modern web developers. **Rage Live Preview** enables opening multiple HTML files concurrently, syncing edits in real-time without page flashing, simulating responsive device layouts, capturing iframe console errors, and visually modifying elements directly from the preview pane!

---

## Key Features

- 👁️ **Simultaneous Multiple Previews**: Unlike standard extensions, you can open and arrange multiple live previews side-by-side.
- ⚡ **Real-Time Synchronisation**: Keystrokes in your HTML or saved changes in your CSS files reflect instantly in the preview with a smooth, scroll-preserving hot-reload.
- 🎨 **Visual Element Inspector & Live Editor**: Toggle inspect mode, select any HTML element, and visually edit its text, attributes, or CSS inline styles directly from the details panel. The extension automatically syncs edits back to your VS Code document!
- 📱 **Integrated Device Simulator**: Simulate standard responsive layouts (Desktop, Tablet, Mobile) with a single click.
- ⚠️ **Console Error Interception**: Captures unhandled promise rejections and script console errors from the webview, showing a red alert badge with a button to locate the exact error line in your code.
- 🧼 **Liquid Glass FAB**: A draggable floating action button that lets you toggle the expanded toolbar from anywhere on the screen, keeping your workspaces clean.
- 💻 **macOS Browser Frame Navigation**: Beautiful title header featuring navigation back/forward/reload buttons and a path bar that lets you load external websites (e.g. YouTube, Google, localhost ports) on-the-fly.

---

## Installation & Setup

### Instant Dev Testing (F5)
1. Open this folder (`c:\Users\Rupeshh\Downloads\proj vs`) in VS Code.
2. Press `F5` (or go to **Run > Start Debugging**).
3. In the new `[Extension Development Host]` window, open any HTML file (for instance, the marketing page in `website/index.html`).
4. **Right-click** anywhere in the editor or the file sidebar, and select **Rage Live Preview**.
5. Your interactive preview panel is now active!

### Permanent Global Installation
1. Open your terminal in the extension folder:
   ```bash
   npx @vscode/vsce package
   ```
2. Install the created package in VS Code:
   ```bash
   code --install-extension rage-live-preview-1.0.1.vsix
   ```
   *(Or click **Extensions Sidebar > ... Menu > Install from VSIX...**)*

---

## How to Use the Visual Editor

1. Click the **Draggable Action Button** (FAB) at the bottom right.
2. The bottom toolbar slides open. Click the **Inspect Element** (cursor target icon) button.
3. Move your mouse over elements in the preview. A dashed cyan border and floating tag badge will highlight them.
4. Click any element. The **Inspect Popup** will slide open, and VS Code will automatically highlight the line in the editor.
5. In the **Info** tab, edit the text content in the textarea. The text in both the preview and the code updates as you type!
6. In the **Attributes** tab, edit attributes (such as `src`, `href`, or `class`).
7. In the **Styles** tab, change computed property values (such as `color`, `background-color`, `font-size`) and watch the visual representation and the inline `style` code edit in real-time!

---

## Repository & Info

- **Version**: 1.0.1
- **Developer**: Rage
- **GitHub**: [https://github.com/rage/rage-live-preview](https://github.com/rage/rage-live-preview)
- **License**: MIT
- **Keywords**: vscode, html, css, live preview, preview, inspector, devtools, browser, responsive, testing, hot reload, base64, iframe, realtime editor.

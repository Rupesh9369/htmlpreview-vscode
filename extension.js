const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

/**
 * @type {Map<string, { panel: vscode.WebviewPanel, document: vscode.TextDocument }>}
 */
const activePreviews = new Map();

/**
 * @type {Map<string, NodeJS.Timeout>}
 */
const debounceTimers = new Map();

let statusBarItem;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Live Preview HTML extension is active.');

    // Create and configure VS Code Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'htmlpreview-vscode.openPreview';
    statusBarItem.text = '$(play) Live Preview HTML';
    statusBarItem.tooltip = 'Show Live Preview HTML';
    context.subscriptions.push(statusBarItem);

    // Watchers to toggle status bar visibility based on active editor file type
    function updateStatusBar() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const ext = path.extname(editor.document.uri.fsPath).toLowerCase();
            const supported = ['.html', '.htm', '.md', '.xml', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.webm', '.pdf'];
            if (supported.includes(ext)) {
                statusBarItem.show();
                return;
            }
        }
        statusBarItem.hide();
    }
    vscode.window.onDidChangeActiveTextEditor(updateStatusBar, null, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(updateStatusBar, null, context.subscriptions);
    updateStatusBar();

    // Register HTML Preview Command (supporting single, bulk, and selected text previews)
    let openPreviewDisposable = vscode.commands.registerCommand('htmlpreview-vscode.openPreview', (uri, selectedUris) => {
        // Handle bulk selection files
        if (selectedUris && selectedUris.length > 1) {
            selectedUris.forEach(u => {
                openPreviewForUri(u, context);
            });
        } else {
            let fileUri = uri;
            if (!fileUri && vscode.window.activeTextEditor) {
                fileUri = vscode.window.activeTextEditor.document.uri;
            }
            openPreviewForUri(fileUri, context);
        }
    });

    context.subscriptions.push(openPreviewDisposable);

    // Watch for document changes (live sync typing)
    const changeDocDisposable = vscode.workspace.onDidChangeTextDocument(e => {
        const uriStr = e.document.uri.toString();
        const preview = activePreviews.get(uriStr);
        if (preview) {
            if (debounceTimers.has(uriStr)) {
                clearTimeout(debounceTimers.get(uriStr));
            }
            const timer = setTimeout(() => {
                updatePreview(preview.panel, e.document, context);
                debounceTimers.delete(uriStr);
            }, 150);
            debounceTimers.set(uriStr, timer);
        }

        // Live refresh HTML previews if workspace CSS changes
        if (e.document.languageId === 'css' || e.document.uri.path.endsWith('.css')) {
            activePreviews.forEach((previewVal) => {
                updatePreview(previewVal.panel, previewVal.document, context);
            });
        }
    });

    context.subscriptions.push(changeDocDisposable);

    // Watch for saves
    const saveDocDisposable = vscode.workspace.onDidSaveTextDocument(doc => {
        const uriStr = doc.uri.toString();
        const preview = activePreviews.get(uriStr);
        if (preview) {
            updatePreview(preview.panel, doc, context);
        }
        
        if (doc.languageId === 'css' || doc.uri.path.endsWith('.css')) {
            activePreviews.forEach((previewVal) => {
                updatePreview(previewVal.panel, previewVal.document, context);
            });
        }
    });

    context.subscriptions.push(saveDocDisposable);
}

/**
 * Handles Webview creation and contents dispatch for a given file URI
 * @param {vscode.Uri} fileUri 
 * @param {vscode.ExtensionContext} context 
 */
/**
 * Unified container HTML with address bar, reload button, and Dev Overlay toggle.
 */
function getContainerHtml(initialFilePath) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: #060810; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
            .header-bar { height: 48px; background: rgba(13, 17, 28, 0.95); border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; align-items: center; padding: 0 16px; gap: 12px; box-sizing: border-box; }
            .logo { color: #00f0ff; font-weight: 800; font-size: 13px; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px; user-select: none; }
            .btn-reload { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); color: #cbd5e1; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 4px; outline: none; }
            .btn-reload:hover { background: rgba(0, 240, 255, 0.1); border-color: #00f0ff; color: #00f0ff; }
            .address-bar { flex: 1; height: 32px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; padding: 0 12px; color: #cbd5e1; font-family: monospace; font-size: 12px; outline: none; transition: border-color 0.2s; }
            .address-bar:focus { border-color: #00f0ff; }
            .toggle-container { display: flex; align-items: center; gap: 8px; color: #cbd5e1; font-size: 12px; font-weight: 600; user-select: none; }
            .switch { position: relative; display: inline-block; width: 36px; height: 20px; }
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15); transition: .3s; border-radius: 20px; }
            .slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 3px; bottom: 3px; background-color: #cbd5e1; transition: .3s; border-radius: 50%; }
            input:checked + .slider { background-color: rgba(0, 240, 255, 0.2); border-color: #00f0ff; }
            input:checked + .slider:before { transform: translateX(16px); background-color: #00f0ff; }
            .preview-frame { flex: 1; border: none; background: #fff; width: 100%; height: 100%; }
        </style>
    </head>
    <body>
        <div class="header-bar">
            <div class="logo">⚡ Live Preview HTML</div>
            <button class="btn-reload" id="reload-btn">
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                Reload
            </button>
            <input type="text" class="address-bar" id="address-input" value="${initialFilePath.replace(/\\/g, '/')}" placeholder="Enter file path or localhost URL..." />
            <div class="toggle-container" id="inspector-toggle-wrap">
                <span>Dev Overlay</span>
                <label class="switch">
                    <input type="checkbox" id="inspector-toggle">
                    <span class="slider"></span>
                </label>
            </div>
        </div>
        <iframe class="preview-frame" id="preview-iframe" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
        <script>
            const vscode = acquireVsCodeApi();
            const iframe = document.getElementById('preview-iframe');
            const addressInput = document.getElementById('address-input');
            const reloadBtn = document.getElementById('reload-btn');
            const inspectorToggle = document.getElementById('inspector-toggle');
            const inspectorToggleWrap = document.getElementById('inspector-toggle-wrap');

            // Handle messages from VS Code
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'updateContent') {
                    addressInput.value = message.filePath;
                    if (message.isHtml) {
                        inspectorToggleWrap.style.display = 'flex';
                        iframe.removeAttribute('src');
                        iframe.srcdoc = message.content;
                    } else {
                        inspectorToggleWrap.style.display = 'none';
                        if (message.isUrl) {
                            iframe.removeAttribute('srcdoc');
                            iframe.src = message.content;
                        } else {
                            iframe.removeAttribute('src');
                            iframe.srcdoc = message.content;
                        }
                    }
                }
            });

            // Address bar input handler
            addressInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    const val = addressInput.value.trim();
                    if (val.startsWith('http://') || val.startsWith('https://')) {
                        vscode.postMessage({ command: 'loadUrl', url: val });
                    } else {
                        vscode.postMessage({ command: 'loadFile', path: val });
                    }
                }
            });

            // Reload handler
            reloadBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'reload' });
            });

            // Inspector Toggle handler
            inspectorToggle.addEventListener('change', () => {
                iframe.contentWindow.postMessage({
                    type: 'toggleInspector',
                    active: inspectorToggle.checked
                }, '*');
            });

            // Listen for updates from the iframe (element editing)
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.type === 'updateDocumentHtml') {
                    vscode.postMessage({
                        command: 'saveHtml',
                        html: message.html
                    });
                }
            });

            // Signal to VS Code extension host that the webview frame is loaded and ready
            vscode.postMessage({ command: 'ready' });
        </script>
    </body>
    </html>
    `;
}

/**
 * Handles Webview creation and contents dispatch for a given file URI
 * @param {vscode.Uri} fileUri 
 * @param {vscode.ExtensionContext} context 
 */
/**
 * Handles Webview creation and contents dispatch for a given file URI
 * @param {vscode.Uri} fileUri 
 * @param {vscode.ExtensionContext} context 
 */
function openPreviewForUri(fileUri, context) {
    if (!fileUri) {
        vscode.window.showErrorMessage('No file selected to preview.');
        return;
    }

    let uriStr = fileUri.toString();

    // Create and show Webview panel
    const panel = vscode.window.createWebviewPanel(
        'htmlPreview.preview',
        `Preview: ${path.basename(fileUri.fsPath)}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'media')),
                vscode.Uri.file(path.dirname(fileUri.fsPath)),
                ...(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(f => f.uri) : [])
            ],
            retainContextWhenHidden: true
        }
    );

    // Render unified container HTML
    panel.webview.html = getContainerHtml(fileUri.fsPath);

    activePreviews.set(uriStr, { panel, document: null, isReady: false });

    // Load Document
    vscode.workspace.openTextDocument(fileUri).then(document => {
        const preview = activePreviews.get(uriStr);
        if (preview) {
            preview.document = document;
            if (preview.isReady) {
                updatePreview(panel, document, context);
            }
        }

        panel.onDidDispose(() => {
            activePreviews.delete(uriStr);
            if (debounceTimers.has(uriStr)) {
                clearTimeout(debounceTimers.get(uriStr));
                debounceTimers.delete(uriStr);
            }
        });
    });

    // Handle messages sent from Webview panel
    panel.webview.onDidReceiveMessage(message => {
        switch (message.command) {
            case 'ready':
                {
                    const preview = activePreviews.get(uriStr);
                    if (preview) {
                        preview.isReady = true;
                        if (preview.document) {
                            updatePreview(panel, preview.document, context);
                        }
                    }
                }
                break;
            case 'reload':
                {
                    const preview = activePreviews.get(uriStr);
                    if (preview && preview.document) {
                        vscode.workspace.openTextDocument(preview.document.uri).then(doc => {
                            preview.document = doc;
                            updatePreview(panel, doc, context);
                        });
                    }
                }
                break;
            case 'loadUrl':
                panel.webview.postMessage({
                    command: 'updateContent',
                    filePath: message.url,
                    content: message.url,
                    isHtml: false,
                    isUrl: true
                });
                break;
            case 'loadFile':
                try {
                    const currentPreview = activePreviews.get(uriStr);
                    const currentDir = currentPreview && currentPreview.document
                        ? path.dirname(currentPreview.document.uri.fsPath)
                        : vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';

                    const fullPath = path.isAbsolute(message.path)
                        ? message.path
                        : path.resolve(currentDir, message.path);

                    const newUri = vscode.Uri.file(fullPath);
                    vscode.workspace.openTextDocument(newUri).then(doc => {
                        // Update target previews map
                        activePreviews.delete(uriStr);
                        uriStr = newUri.toString();
                        activePreviews.set(uriStr, { panel, document: doc, isReady: true });
                        updatePreview(panel, doc, context);
                    }, err => {
                        vscode.window.showErrorMessage('Could not open file: ' + err.message);
                    });
                } catch (err) {
                    vscode.window.showErrorMessage('Error resolving path: ' + err.message);
                }
                break;
            case 'saveHtml':
                {
                    const preview = activePreviews.get(uriStr);
                    if (preview && preview.document) {
                        // Strip injected scripts from edited html before saving
                        let cleanHtml = message.html
                            .replace(/<!-- INJECT_SCROLL_START -->[\s\S]*?<!-- INJECT_SCROLL_END -->/g, '')
                            .replace(/<!-- INJECT_INSPECTOR_START -->[\s\S]*?<!-- INJECT_INSPECTOR_END -->/g, '');

                        // Restore original CSS link tags and remove inlined <style> elements
                        cleanHtml = cleanHtml.replace(/<!-- INLINE_CSS_ORIGINAL_START href="[^"]*" -->([\s\S]*?)<!-- INLINE_CSS_ORIGINAL_END -->\s*<style data-inlined-from="[^"]*">[\s\S]*?<\/style>/gi, '$1');

                        // Restore original JS script tags and remove inlined <script> elements
                        cleanHtml = cleanHtml.replace(/<!-- INLINE_JS_ORIGINAL_START src="[^"]*" -->([\s\S]*?)<!-- INLINE_JS_ORIGINAL_END -->\s*<script data-inlined-from="[^"]*">[\s\S]*?<\/script>/gi, '$1');

                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            preview.document.positionAt(0),
                            preview.document.positionAt(preview.document.getText().length)
                        );
                        edit.replace(preview.document.uri, fullRange, cleanHtml);
                        vscode.workspace.applyEdit(edit).then(success => {
                            if (success) {
                                preview.document.save();
                            }
                        });
                    }
                }
                break;
        }
    });
}

/**
 * Prepares the visual asset outputs (HTML, Markdown, XML, CSV, Image, Video, PDF)
 */
function updatePreview(panel, document, context) {
    try {
        const filePath = document.uri.fsPath;
        const ext = path.extname(filePath).toLowerCase();
        
        let content = '';
        let isHtml = false;

        // 1. Image formats
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
        if (imageExts.includes(ext)) {
            const imageUri = panel.webview.asWebviewUri(document.uri);
            content = getImageHtml(imageUri.toString());
        }
        // 2. Video formats
        else if (['.mp4', '.webm', '.ogg'].includes(ext)) {
            const videoUri = panel.webview.asWebviewUri(document.uri);
            content = getVideoHtml(videoUri.toString());
        }
        // 3. PDF Format
        else if (ext === '.pdf') {
            const pdfUri = panel.webview.asWebviewUri(document.uri);
            content = `
                <!DOCTYPE html>
                <html style="margin:0;padding:0;height:100%;">
                <body style="margin:0;padding:0;height:100%;background:#060810;display:flex;align-items:center;justify-content:center;">
                    <embed src="${pdfUri}" type="application/pdf" style="width:100%;height:100%;border:none;">
                </body>
                </html>
            `;
        }
        // 4. Markdown Formatting
        else if (ext === '.md') {
            content = parseMarkdown(document.getText());
        }
        // 5. XML Formatting
        else if (ext === '.xml') {
            content = formatXml(document.getText());
        }
        // 6. CSV/SSV formatting
        else if (ext === '.csv' || ext === '.ssv') {
            content = formatCsv(document.getText(), ext === '.csv' ? ',' : ';');
        }
        // 7. Core HTML Code Rendering
        else {
            isHtml = true;
            const baseUri = panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(filePath)));
            content = injectPreviewScripts(document.getText(), filePath, baseUri.toString() + '/');
        }

        panel.webview.postMessage({
            command: 'updateContent',
            filePath: filePath,
            content: content,
            isHtml: isHtml
        });
    } catch (err) {
        console.error(err);
    }
}

/**
 * Parses markdown to HTML
 */
function parseMarkdown(md) {
    let html = md
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
        
    html = html.replace(/^\>\s+(.*)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    html = html.replace(/```(\w*)\n([\s\S]*?)```/gm, (match, lang, code) => `<pre><code class="language-${lang}">${code}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/^\s*[\-\*]\s+(.*)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    
    html = html.split(/\n\s*\n/).map(p => {
        const t = p.trim();
        if (t.startsWith('<h') || t.startsWith('<pre') || t.startsWith('<ul') || t.startsWith('<li') || t.startsWith('<block')) {
            return p;
        }
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #e2e8f0; background: #05070f; padding: 32px; max-width:800px; margin:0 auto; }
            h1, h2, h3 { color: #00f0ff; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 8px; font-family: sans-serif; }
            pre { background: #0b0f19; border: 1px solid rgba(255,255,255,0.08); padding: 16px; border-radius: 8px; overflow-x: auto; }
            code { font-family: monospace; color: #a5b4fc; background: #0b0f19; padding: 2px 6px; border-radius: 4px; }
            blockquote { border-left: 4px solid #3b82f6; padding-left: 16px; color: #94a3b8; font-style: italic; margin: 16px 0; }
            li { margin-bottom: 6px; }
            p { color: #cbd5e1; }
        </style>
    </head>
    <body>${html}</body>
    </html>
    `;
}

/**
 * Formats XML
 */
function formatXml(xml) {
    let escaped = xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    escaped = escaped.replace(/(&lt;\/?[a-zA-Z0-9:-]+)/g, '<span class="xml-tag">$1</span>');
    escaped = escaped.replace(/(\s[a-zA-Z0-9:-]+=)/g, '<span class="xml-attr">$1</span>');
    escaped = escaped.replace(/("[^"]*")/g, '<span class="xml-val">$1</span>');
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { background: #05070f; color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; padding: 32px; font-size:12px; line-height:1.6; }
            pre { margin:0; }
            .xml-tag { color: #f43f5e; font-weight: 700; }
            .xml-attr { color: #fb923c; }
            .xml-val { color: #34d399; }
        </style>
    </head>
    <body><pre><code>${escaped}</code></pre></body>
    </html>
    `;
}

/**
 * Formats CSV/SSV
 */
function formatCsv(csv, sep) {
    const lines = csv.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length === 0) return '<p>Empty dataset</p>';
    
    let html = '<table>';
    lines.forEach((line, index) => {
        const cols = line.split(sep);
        const cellTag = index === 0 ? 'th' : 'td';
        html += '<tr>';
        cols.forEach(col => {
            html += `<${cellTag}>${col.trim().replace(/^["']|["']$/g, '')}</${cellTag}>`;
        });
        html += '</tr>';
    });
    html += '</table>';
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: -apple-system, sans-serif; padding: 24px; background: #05070f; color: #cbd5e1; }
            table { border-collapse: collapse; width: 100%; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; overflow: hidden; background:#0b0f19; }
            th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px; }
            th { background: rgba(0, 240, 255, 0.1); color: #00f0ff; font-weight: 700; }
            tr:hover { background: rgba(255,255,255,0.02); }
        </style>
    </head>
    <body>${html}</body>
    </html>
    `;
}

/**
 * Image Viewer
 */
function getImageHtml(imageUri) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { margin:0; padding:0; background:#05070f; height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; font-family:sans-serif; color:#fff; user-select:none; }
            .img-viewport { flex:1; width:100%; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; cursor:grab; }
            .img-viewport:active { cursor:grabbing; }
            img { max-width:90%; max-height:90%; object-fit:contain; transition:transform 0.1s ease; transform-origin:center center; }
            .controls { position:fixed; bottom:24px; background:rgba(20,20,30,0.85); backdrop-filter:blur(12px); border:1px solid rgba(255,255,255,0.1); padding:8px 16px; border-radius:9999px; display:flex; gap:16px; align-items:center; box-shadow:0 10px 30px rgba(0,0,0,0.5); }
            button { background:transparent; border:none; color:#00f0ff; font-size:18px; cursor:pointer; font-weight:700; width:32px; height:32px; display:flex; align-items:center; justify-content:center; border-radius:50%; transition:background 0.2s; outline:none; }
            button:hover { background:rgba(255,255,255,0.1); }
            .zoom-level { font-family:monospace; font-size:12px; min-width:48px; text-align:center; color:#cbd5e1; }
        </style>
    </head>
    <body>
        <div class="img-viewport" id="viewport"><img src="${imageUri}" id="preview-image" /></div>
        <div class="controls">
            <button id="btn-zoom-out">-</button>
            <span class="zoom-level" id="zoom-text">100%</span>
            <button id="btn-zoom-in">+</button>
            <button id="btn-reset" style="font-size:11px;">Reset</button>
        </div>
        <script>
            let scale = 1, posX = 0, posY = 0, isDragging = false, startX, startY;
            const img = document.getElementById('preview-image');
            const viewport = document.getElementById('viewport');
            const zoomText = document.getElementById('zoom-text');
            
            document.getElementById('btn-zoom-in').onclick = () => zoom(0.15);
            document.getElementById('btn-zoom-out').onclick = () => zoom(-0.15);
            document.getElementById('btn-reset').onclick = () => { scale = 1; posX = 0; posY = 0; updateTransform(); };
            
            function zoom(amount) { scale = Math.max(0.15, Math.min(8, scale + amount)); updateTransform(); }
            function updateTransform() { img.style.transform = "translate(" + posX + "px, " + posY + "px) scale(" + scale + ")"; zoomText.textContent = Math.round(scale * 100) + '%'; }
            
            viewport.onmousedown = (e) => { if (e.button !== 0) return; isDragging = true; startX = e.clientX - posX; startY = e.clientY - posY; e.preventDefault(); };
            window.onmousemove = (e) => { if (!isDragging) return; posX = e.clientX - startX; posY = e.clientY - startY; updateTransform(); };
            window.onmouseup = () => { isDragging = false; };
            viewport.onwheel = (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 0.1 : -0.1); };
        </script>
    </body>
    </html>
    `;
}

/**
 * Video Viewer
 */
function getVideoHtml(videoUri) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { margin:0; padding:0; background:#05070f; height:100vh; display:flex; align-items:center; justify-content:center; font-family:sans-serif; }
            .video-container { position:relative; max-width:90%; max-height:90%; border-radius:12px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.1); }
            video { width:100%; display:block; }
            .custom-controls { position:absolute; bottom:0; left:0; right:0; background:linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0)); padding:24px 16px 12px 16px; display:flex; align-items:center; gap:12px; opacity:0; transition:opacity 0.3s; }
            .video-container:hover .custom-controls { opacity:1; }
            button { background:transparent; border:none; color:#00f0ff; font-size:12px; font-weight:700; cursor:pointer; outline:none; }
            .timeline { flex:1; accent-color:#00f0ff; height:4px; cursor:pointer; }
            .time { color:#fff; font-family:monospace; font-size:11px; }
        </style>
    </head>
    <body>
        <div class="video-container">
            <video id="video-player" src="${videoUri}" autoplay></video>
            <div class="custom-controls">
                <button id="btn-play">Pause</button>
                <input type="range" class="timeline" id="timeline" min="0" max="100" value="0" />
                <span class="time" id="time-display">0:00 / 0:00</span>
                <button id="btn-mute">Mute</button>
            </div>
        </div>
        <script>
            const video = document.getElementById('video-player');
            const btnPlay = document.getElementById('btn-play');
            const btnMute = document.getElementById('btn-mute');
            const timeline = document.getElementById('timeline');
            const timeDisplay = document.getElementById('time-display');
            
            btnPlay.onclick = () => {
                if (video.paused) { video.play(); btnPlay.textContent = 'Pause'; }
                else { video.pause(); btnPlay.textContent = 'Play'; }
            };
            btnMute.onclick = () => { video.muted = !video.muted; btnMute.textContent = video.muted ? 'Unmute' : 'Mute'; };
            video.ontimeupdate = () => {
                if (video.duration) {
                    const pct = (video.currentTime / video.duration) * 100;
                    timeline.value = pct;
                    timeDisplay.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
                }
            };
            timeline.oninput = () => { video.currentTime = (timeline.value / 100) * video.duration; };
            function formatTime(s) { const m = Math.floor(s/60); const sec = Math.floor(s%60); return m + ':' + (sec<10?'0':'') + sec; }
        </script>
    </body>
    </html>
    `;
}

/**
 * Injects `<base>` tag, scroll state restoration, and edit inspector scripts
 * @param {string} html 
 * @param {string} baseUri 
 * @returns {string}
 */**
 * Inlines relative CSS and JS files directly into the HTML to bypass Webview CSP blockages
 * @param {string} html 
 * @param {string} htmlFilePath 
 * @returns {string}
 */
function inlineAssets(html, htmlFilePath) {
    let result = html;
    const dir = path.dirname(htmlFilePath);

    // Inline CSS Stylesheet Links
    const linkRegex = /<link\s+[^>]*href=["']([^"']+\.css)["'][^>]*>/gi;
    result = result.replace(linkRegex, (match, href) => {
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
            return match;
        }
        try {
            const cssPath = path.resolve(dir, href);
            if (fs.existsSync(cssPath)) {
                const cssContent = fs.readFileSync(cssPath, 'utf8');
                return `<!-- INLINE_CSS_ORIGINAL_START href="${href}" -->${match}<!-- INLINE_CSS_ORIGINAL_END -->\n<style data-inlined-from="${href}">\n${cssContent}\n</style>`;
            }
        } catch (err) {
            console.error('Error inlining CSS:', href, err);
        }
        return match;
    });

    // Inline JS Scripts
    const scriptRegex = /<script\s+[^>]*src=["']([^"']+\.js)["'][^>]*>\s*<\/script>/gi;
    result = result.replace(scriptRegex, (match, src) => {
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
            return match;
        }
        try {
            const jsPath = path.resolve(dir, src);
            if (fs.existsSync(jsPath)) {
                const jsContent = fs.readFileSync(jsPath, 'utf8');
                return `<!-- INLINE_JS_ORIGINAL_START src="${src}" -->${match}<!-- INLINE_JS_ORIGINAL_END -->\n<script data-inlined-from="${src}">\n${jsContent}\n</script>`;
            }
        } catch (err) {
            console.error('Error inlining JS:', src, err);
        }
        return match;
    });

    return result;
}

/**
 * Injects `<base>` tag, scroll state restoration, and edit inspector scripts
 * @param {string} html 
 * @param {string} htmlFilePath
 * @param {string} baseUri 
 * @returns {string}
 */
function injectPreviewScripts(html, htmlFilePath, baseUri) {
    // 1. Inline CSS and JS assets locally
    let result = inlineAssets(html, htmlFilePath);
    
    // Inject <base> tag
    const baseTag = `<base href="${baseUri}">`;
    if (result.includes('<head>')) { result = result.replace('<head>', `<head>${baseTag}`); }
    else if (result.includes('<HEAD>')) { result = result.replace('<HEAD>', `<HEAD>${baseTag}`); }
    else { result = baseTag + result; }
    
    // Inject Scroll State Restoration script
    const scrollScript = `<!-- INJECT_SCROLL_START -->
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            // Restore scroll position
            const state = vscode.getState();
            if (state) {
                window.scrollTo(state.scrollX, state.scrollY);
            }
            // Save scroll position on scroll events
            window.addEventListener('scroll', () => {
                vscode.setState({ scrollX: window.scrollX, scrollY: window.scrollY });
            });
        })();
    </script>
    <!-- INJECT_SCROLL_END -->`;
    
    // Inject Dev Overlay Inspector script
    const inspectorScript = `<!-- INJECT_INSPECTOR_START -->
    <script>
    (function() {
        let inspectorActive = false;
        let hoveredEl = null;

        // Create the editing modal
        const modal = document.createElement('div');
        modal.id = 'live-preview-edit-modal';
        modal.style.cssText = 'position:fixed;z-index:999999;background:#0d111c;color:#cbd5e1;border:1px solid #00f0ff;border-radius:8px;padding:16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);width:300px;display:none;flex-direction:column;gap:10px;';
        modal.innerHTML = \`
            <div style="font-weight:bold;color:#00f0ff;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
                <span>Edit Element: &lt;<span id="modal-tag-name"></span>&gt;</span>
            </div>
            <div>
                <label style="display:block;margin-bottom:4px;font-weight:600;">Text / HTML Content:</label>
                <textarea id="modal-text-content" rows="4" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#fff;padding:6px;box-sizing:border-box;font-family:monospace;font-size:11px;outline:none;resize:vertical;"></textarea>
            </div>
            <div>
                <label style="display:block;margin-bottom:4px;font-weight:600;">Inline Style (CSS):</label>
                <input type="text" id="modal-style-content" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#fff;padding:6px;box-sizing:border-box;outline:none;" />
            </div>
            <div>
                <label style="display:block;margin-bottom:4px;font-weight:600;">Classes:</label>
                <input type="text" id="modal-class-content" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#fff;padding:6px;box-sizing:border-box;outline:none;" />
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
                <button id="modal-btn-cancel" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#cbd5e1;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:600;outline:none;">Cancel</button>
                <button id="modal-btn-save" style="background:#00f0ff;border:none;color:#0d111c;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:bold;outline:none;">Save Changes</button>
            </div>
        \`;
        document.body.appendChild(modal);

        const modalTagName = modal.querySelector('#modal-tag-name');
        const modalText = modal.querySelector('#modal-text-content');
        const modalStyle = modal.querySelector('#modal-style-content');
        const modalClass = modal.querySelector('#modal-class-content');
        const btnCancel = modal.querySelector('#modal-btn-cancel');
        const btnSave = modal.querySelector('#modal-btn-save');

        let currentEditingEl = null;

        window.addEventListener('message', event => {
            const data = event.data;
            if (data.type === 'toggleInspector') {
                inspectorActive = data.active;
                if (!inspectorActive) {
                    if (hoveredEl) {
                        hoveredEl.style.outline = hoveredEl.dataset.origOutline || '';
                        hoveredEl = null;
                    }
                    modal.style.display = 'none';
                }
            }
        });

        document.addEventListener('mouseover', e => {
            if (!inspectorActive) return;
            if (e.target === modal || modal.contains(e.target)) return;
            
            if (hoveredEl && hoveredEl !== e.target) {
                hoveredEl.style.outline = hoveredEl.dataset.origOutline || '';
            }
            hoveredEl = e.target;
            if (!hoveredEl.dataset.hasOwnProperty('origOutline')) {
                hoveredEl.dataset.origOutline = hoveredEl.style.outline;
            }
            hoveredEl.style.outline = '2px dashed #00f0ff';
            hoveredEl.style.outlineOffset = '-2px';
        });

        document.addEventListener('mouseout', e => {
            if (!inspectorActive) return;
            if (e.target === hoveredEl) {
                hoveredEl.style.outline = hoveredEl.dataset.origOutline || '';
                hoveredEl = null;
            }
        });

        document.addEventListener('click', e => {
            if (!inspectorActive) return;
            if (e.target === modal || modal.contains(e.target)) return;
            
            e.preventDefault();
            e.stopPropagation();

            currentEditingEl = e.target;
            modalTagName.textContent = currentEditingEl.tagName.toLowerCase();
            modalText.value = currentEditingEl.innerHTML;
            modalStyle.value = currentEditingEl.getAttribute('style') || '';
            modalClass.value = currentEditingEl.getAttribute('class') || '';

            const rect = currentEditingEl.getBoundingClientRect();
            let top = rect.bottom + window.scrollY + 10;
            let left = rect.left + window.scrollX;
            
            if (left + 320 > window.innerWidth) left = window.innerWidth - 340;
            if (left < 10) left = 10;
            if (top + 250 > window.innerHeight) top = rect.top + window.scrollY - 230;
            if (top < 10) top = 10;

            modal.style.top = top + 'px';
            modal.style.left = left + 'px';
            modal.style.display = 'flex';
        }, true);

        btnCancel.onclick = () => {
            modal.style.display = 'none';
            currentEditingEl = null;
        };

        btnSave.onclick = () => {
            if (currentEditingEl) {
                currentEditingEl.innerHTML = modalText.value;
                if (modalStyle.value.trim() !== '') {
                    currentEditingEl.setAttribute('style', modalStyle.value);
                } else {
                    currentEditingEl.removeAttribute('style');
                }
                if (modalClass.value.trim() !== '') {
                    currentEditingEl.setAttribute('class', modalClass.value);
                } else {
                    currentEditingEl.removeAttribute('class');
                }
                
                currentEditingEl.style.outline = currentEditingEl.dataset.origOutline || '';
                delete currentEditingEl.dataset.origOutline;
                
                modal.style.display = 'none';
                modal.remove();
                
                const docHtml = document.documentElement.outerHTML;
                document.body.appendChild(modal);

                window.parent.postMessage({
                    type: 'updateDocumentHtml',
                    html: '<!DOCTYPE html>\\n' + docHtml
                }, '*');
                
                currentEditingEl = null;
            }
        };
    })();
    </script>
    <!-- INJECT_INSPECTOR_END -->`;

    const combined = scrollScript + '\n' + inspectorScript;
    if (result.includes('</body>')) { result = result.replace('</body>', `${combined}</body>`); }
    else if (result.includes('</BODY>')) { result = result.replace('</BODY>', `${combined}</BODY>`); }
    else { result = result + combined; }
    
    return result;
}

function deactivate() {
    activePreviews.forEach(p => p.panel.dispose());
    activePreviews.clear();
    debounceTimers.forEach(t => clearTimeout(t));
    debounceTimers.clear();
    if (statusBarItem) statusBarItem.dispose();
}

module.exports = {
    activate,
    deactivate
};

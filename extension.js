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
function openPreviewForUri(fileUri, context) {
    if (!fileUri) {
        vscode.window.showErrorMessage('No file selected to preview.');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    let isSelectionPreview = false;
    let selectedText = '';

    // Check if there is an active editor selection
    if (editor && editor.document.uri.toString() === fileUri.toString() && !editor.selection.isEmpty) {
        isSelectionPreview = true;
        selectedText = editor.document.getText(editor.selection);
    }

    const uriStr = isSelectionPreview ? `selection-${Date.now()}` : fileUri.toString();

    const panel = vscode.window.createWebviewPanel(
        'htmlPreview.preview',
        isSelectionPreview ? 'HTML Selection Sandbox' : `Preview: ${path.basename(fileUri.fsPath)}`,
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

    if (!isSelectionPreview) {
        activePreviews.set(uriStr, { panel, document: null });
    }

    // Load Document
    vscode.workspace.openTextDocument(fileUri).then(document => {
        if (!isSelectionPreview) {
            activePreviews.get(uriStr).document = document;
        }

        // Initialize content based on type
        if (isSelectionPreview) {
            panel.webview.html = getSandboxHtml(selectedText);
        } else {
            updatePreview(panel, document, context);
        }

        panel.onDidDispose(() => {
            activePreviews.delete(uriStr);
            if (debounceTimers.has(uriStr)) {
                clearTimeout(debounceTimers.get(uriStr));
                debounceTimers.delete(uriStr);
            }
        });
    });
}

/**
 * Prepares the visual asset outputs (HTML, Markdown, XML, CSV, Image, Video, PDF)
 */
function updatePreview(panel, document, context) {
    try {
        const filePath = document.uri.fsPath;
        const ext = path.extname(filePath).toLowerCase();
        
        // 1. Image formats
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
        if (imageExts.includes(ext)) {
            const imageUri = panel.webview.asWebviewUri(document.uri);
            panel.webview.html = getImageHtml(imageUri.toString());
            return;
        }

        // 2. Video formats
        const videoExts = ['.mp4', '.webm', '.ogg'];
        if (videoExts.includes(ext)) {
            const videoUri = panel.webview.asWebviewUri(document.uri);
            panel.webview.html = getVideoHtml(videoUri.toString());
            return;
        }

        // 3. PDF Format
        if (ext === '.pdf') {
            const pdfUri = panel.webview.asWebviewUri(document.uri);
            panel.webview.html = `
                <!DOCTYPE html>
                <html style="margin:0;padding:0;height:100%;">
                <body style="margin:0;padding:0;height:100%;background:#060810;display:flex;align-items:center;justify-content:center;">
                    <embed src="${pdfUri}" type="application/pdf" style="width:100%;height:100%;border:none;">
                </body>
                </html>
            `;
            return;
        }

        // Read textual contents
        const fileContent = document.getText();

        // 4. Markdown Formatting
        if (ext === '.md') {
            panel.webview.html = parseMarkdown(fileContent);
            return;
        }

        // 5. XML Formatting
        if (ext === '.xml') {
            panel.webview.html = formatXml(fileContent);
            return;
        }

        // 6. CSV/SSV formatting
        if (ext === '.csv' || ext === '.ssv') {
            panel.webview.html = formatCsv(fileContent, ext === '.csv' ? ',' : ';');
            return;
        }

        // 7. Core HTML Code Rendering (Simple and Direct)
        const baseUri = panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(filePath)));
        panel.webview.html = injectBaseAndScrollScript(fileContent, baseUri.toString() + '/');
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
 * Selected HTML sandbox layout with tabbed HTML/CSS/JS panels
 */
function getSandboxHtml(initialHtml) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { margin:0; padding:0; background:#05070f; font-family:-apple-system, sans-serif; display:flex; flex-direction:column; height:100vh; overflow:hidden; }
            .sandbox-header { height:44px; background:rgba(22, 22, 29, 0.95); border-bottom:1px solid rgba(255,255,255,0.06); display:flex; align-items:center; padding:0 16px; justify-content:space-between; }
            .sandbox-title { color:#00f0ff; font-weight:700; font-size:12px; letter-spacing:1px; }
            .sandbox-split { flex:1; display:flex; height:calc(100vh - 44px); }
            .editor-pane { width:45%; border-right:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; background:#080a10; }
            .editor-tabs { display:flex; background:rgba(0,0,0,0.25); border-bottom:1px solid rgba(255,255,255,0.04); }
            .editor-tab { flex:1; background:transparent; border:none; color:#64748b; padding:10px; font-weight:700; cursor:pointer; text-align:center; font-size:11px; border-bottom:2px solid transparent; outline:none; transition:all 0.2s; }
            .editor-tab.active { color:#00f0ff; border-bottom-color:#00f0ff; background:rgba(0, 240, 255, 0.03); }
            .editor-content { flex:1; display:flex; position:relative; }
            textarea { position:absolute; top:0; left:0; width:100%; height:100%; background:transparent; border:none; color:#cbd5e1; font-family:monospace; font-size:12px; padding:16px; outline:none; resize:none; box-sizing:border-box; display:none; }
            textarea.active { display:block; }
            .preview-pane { flex:1; background:#fff; position:relative; }
            iframe { border:none; width:100%; height:100%; }
        </style>
    </head>
    <body>
        <div class="sandbox-header">
            <span class="sandbox-title">⚡ HTML SELECTION SANDBOX</span>
            <span style="color:#64748b; font-size:10px; font-weight:700;">LIVE INTERACTIVE RUNNER</span>
        </div>
        <div class="sandbox-split">
            <div class="editor-pane">
                <div class="editor-tabs">
                    <button class="editor-tab active" data-editor="html">HTML</button>
                    <button class="editor-tab" data-editor="css">CSS</button>
                    <button class="editor-tab" data-editor="js">JS</button>
                </div>
                <div class="editor-content">
                    <textarea id="editor-html" class="active" placeholder="Write HTML here...">${initialHtml}</textarea>
                    <textarea id="editor-css" placeholder="Write CSS here..."></textarea>
                    <textarea id="editor-js" placeholder="Write JavaScript here..."></textarea>
                </div>
            </div>
            <div class="preview-pane"><iframe id="sandbox-iframe"></iframe></div>
        </div>
        <script>
            const htmlArea = document.getElementById('editor-html');
            const cssArea = document.getElementById('editor-css');
            const jsArea = document.getElementById('editor-js');
            const iframe = document.getElementById('sandbox-iframe');
            
            const tabs = document.querySelectorAll('.editor-tab');
            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    tabs.forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    document.querySelectorAll('textarea').forEach(tx => tx.classList.remove('active'));
                    document.getElementById('editor-' + tab.getAttribute('data-editor')).classList.add('active');
                });
            });
            
            function updatePreview() {
                iframe.srcdoc = "<!DOCTYPE html><html><head><style>" + cssArea.value + "</style></head><body>" + htmlArea.value + "<script>" + jsArea.value + "</script></body></html>";
            }
            htmlArea.oninput = updatePreview;
            cssArea.oninput = updatePreview;
            jsArea.oninput = updatePreview;
            updatePreview();
        </script>
    </body>
    </html>
    `;
}

/**
 * Injects `<base>` and scroll preservation script into the HTML content
 * @param {string} html 
 * @param {string} baseUri 
 * @returns {string}
 */
function injectBaseAndScrollScript(html, baseUri) {
    let result = html;
    
    // Inject <base> tag
    const baseTag = `<base href="${baseUri}">`;
    if (result.includes('<head>')) { result = result.replace('<head>', `<head>${baseTag}`); }
    else if (result.includes('<HEAD>')) { result = result.replace('<HEAD>', `<HEAD>${baseTag}`); }
    else { result = baseTag + result; }
    
    // Inject Scroll State Restoration script
    const scrollScript = `
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
    `;
    
    if (result.includes('</body>')) { result = result.replace('</body>', `${scrollScript}</body>`); }
    else if (result.includes('</BODY>')) { result = result.replace('</BODY>', `${scrollScript}</BODY>`); }
    else { result = result + scrollScript; }
    
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

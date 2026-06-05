const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

/**
 * @type {Map<string, { panel: vscode.WebviewPanel, filePath: string, port: number, server: http.Server, sseClients: any[] }>}
 */
const activePreviews = new Map(); // Key: port (string), Value: preview entry

/**
 * @type {Map<string, NodeJS.Timeout>}
 */
const debounceTimers = new Map();

let statusBarItem;

function getServerUrl(filePath, port) {
    let normalized = filePath.replace(/\\/g, '/');
    if (normalized.startsWith('/')) {
        normalized = normalized.substring(1);
    }
    const segments = normalized.split('/').map(seg => encodeURIComponent(seg));
    return `http://127.0.0.1:${port}/${segments.join('/')}`;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function checkPort(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => {
            resolve(false); // Port in use
        });
        server.once('listening', () => {
            server.close();
            resolve(true); // Port free
        });
        server.listen(port, '127.0.0.1');
    });
}

async function findAvailablePort(startPort) {
    let port = startPort;
    while (true) {
        let portInSession = false;
        activePreviews.forEach((preview) => {
            if (preview.port === port) {
                portInSession = true;
            }
        });
        
        if (!portInSession) {
            const isFree = await checkPort(port);
            if (isFree) {
                return port;
            }
        }
        port++;
    }
}

function createServerForPreview(entry, port) {
    const sseClients = [];
    
    const serverInstance = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const urlParts = req.url.split('?');
        const decodedUrl = decodeURIComponent(urlParts[0]);
        const searchParams = new URLSearchParams(urlParts[1] || '');
        const isRaw = searchParams.get('raw') === 'true';

        // SSE Reload Endpoint
        if (decodedUrl.startsWith('/change-sse')) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            sseClients.push(res);
            req.on('close', () => {
                const idx = sseClients.indexOf(res);
                if (idx !== -1) {
                    sseClients.splice(idx, 1);
                }
            });
            return;
        }

        // Resolve requested file path
        let isMain = false;
        let targetFsPath = '';

        const cleanUrl = decodedUrl.replace(/^\//, '');
        const cleanFilePath = entry.filePath.replace(/^\//, '');

        // Check if main file request
        if (decodedUrl === '/' || decodedUrl === '' || cleanUrl.toLowerCase() === cleanFilePath.toLowerCase() || decodedUrl.toLowerCase().endsWith(path.basename(entry.filePath).toLowerCase())) {
            isMain = true;
            targetFsPath = entry.filePath;
        } else {
            // Asset request: resolve relative to file's directory
            const fileDir = path.dirname(entry.filePath);
            targetFsPath = path.resolve(fileDir, cleanUrl);
        }

        targetFsPath = targetFsPath.replace(/\\/g, '/');

        if (isMain && !isRaw) {
            servePreviewFile(targetFsPath, res, sseClients, req);
        } else {
            serveStaticFile(targetFsPath, res, req);
        }
    });

    serverInstance.listen(port, '127.0.0.1');
    
    serverInstance.on('error', (err) => {
        console.error(`Server error on port ${port}:`, err);
    });

    entry.server = serverInstance;
    entry.sseClients = sseClients;
}

function triggerSseReload(preview) {
    if (preview && preview.sseClients) {
        preview.sseClients.forEach(res => {
            try {
                res.write(`data: reload\n\n`);
            } catch (err) {
                console.error('Error writing reload message to SSE client:', err);
            }
        });
    }
}

function updateAllWebviews() {
    const list = Array.from(activePreviews.values()).map(p => ({
        port: p.port,
        filePath: p.filePath,
        fileName: path.basename(p.filePath)
    }));
    
    activePreviews.forEach(p => {
        try {
            p.panel.webview.postMessage({
                command: 'updateRunningInstances',
                instances: list
            });
        } catch (e) {
            // Webview might have been disposed
        }
    });
}

function servePreviewFile(fsPath, res, sseClients, req) {
    try {
        const ext = path.extname(fsPath).toLowerCase();
        const textExts = ['.html', '.htm', '.xml', '.csv', '.ssv', '.md'];
        
        let content = '';
        if (textExts.includes(ext)) {
            let doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.replace(/\\/g, '/').toLowerCase() === fsPath.toLowerCase());
            if (doc) {
                content = doc.getText();
            } else {
                if (fs.existsSync(fsPath)) {
                    content = fs.readFileSync(fsPath, 'utf8');
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('File not found: ' + fsPath);
                    return;
                }
            }
        }

        // 1. Image formats (served via asWebviewUri for main preview, but keep as fallback)
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
        if (imageExts.includes(ext)) {
            const parsedHtml = getImageHtmlForServer(fsPath);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(parsedHtml);
            return;
        }

        // 2. Video formats
        const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi'];
        if (videoExts.includes(ext)) {
            const parsedHtml = getVideoHtmlForServer(fsPath);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(parsedHtml);
            return;
        }

        // 2b. Audio formats
        const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
        if (audioExts.includes(ext)) {
            const parsedHtml = getAudioHtmlForServer(fsPath);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(parsedHtml);
            return;
        }

        // 3. PDF Format - Serve the custom PDF.js HTML viewer page
        if (ext === '.pdf') {
            const parsedHtml = getPdfHtmlForServer(fsPath);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(parsedHtml);
            return;
        }

        // 4. Markdown Formatting
        if (ext === '.md') {
            const parsedHtml = parseMarkdownForServer(content, fsPath);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(parsedHtml);
            return;
        }

        // 5. XML Formatting
        if (ext === '.xml') {
            const parsedHtml = formatXmlForServer(content);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(parsedHtml);
            return;
        }

        // 6. CSV/SSV formatting
        if (ext === '.csv' || ext === '.ssv') {
            const parsedHtml = formatCsvForServer(content, ext === '.csv' ? ',' : ';');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(parsedHtml);
            return;
        }

        // 7. Core HTML Code Rendering
        const port = res.socket.localPort;
        const baseUri = `http://127.0.0.1:${port}/${encodeURIComponent(path.dirname(fsPath).replace(/\\/g, '/'))}/`;
        let result = content;
        
        // Inject <base> tag
        const baseTag = `<base href="${baseUri}">`;
        if (result.includes('<head>')) { result = result.replace('<head>', `<head>${baseTag}`); }
        else if (result.includes('<HEAD>')) { result = result.replace('<HEAD>', `<HEAD>${baseTag}`); }
        else { result = baseTag + result; }
        
        // Inject reload SSE script (no inspectorScript injected)
        const injectedStuff = `
        ${sseScript()}
        `;
        if (result.includes('</body>')) { result = result.replace('</body>', `${injectedStuff}</body>`); }
        else if (result.includes('</BODY>')) { result = result.replace('</BODY>', `${injectedStuff}</BODY>`); }
        else { result = result + injectedStuff; }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(result);
    } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server Error: ' + err.message);
    }
}

function serveStaticFile(fsPath, res, req) {
    try {
        const ext = path.extname(fsPath).toLowerCase();
        const textExts = ['.html', '.htm', '.css', '.js', '.json', '.xml', '.csv', '.ssv', '.md'];

        if (textExts.includes(ext)) {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.replace(/\\/g, '/').toLowerCase() === fsPath.toLowerCase());
            if (doc) {
                const mimeType = getMimeType(fsPath);
                res.writeHead(200, { 'Content-Type': mimeType + '; charset=utf-8' });
                res.end(doc.getText());
                return;
            }
        }

        if (!fs.existsSync(fsPath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('File not found: ' + fsPath);
            return;
        }
        
        const mimeType = getMimeType(fsPath);
        const stat = fs.statSync(fsPath);
        const fileSize = stat.size;
        const range = req ? req.headers.range : null;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            let start = parseInt(parts[0], 10);
            let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (isNaN(start)) {
                start = fileSize - end;
                end = fileSize - 1;
            }
            if (isNaN(end)) {
                end = fileSize - 1;
            }

            if (start >= fileSize) {
                res.writeHead(416, {
                    'Content-Range': `bytes */${fileSize}`,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': '*'
                });
                return res.end();
            }

            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(fsPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': mimeType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': '*'
            };

            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': mimeType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': '*'
            };
            res.writeHead(200, head);
            fs.createReadStream(fsPath).pipe(res);
        }
    } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error serving file: ' + err.message);
    }
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.html': case '.htm': return 'text/html';
        case '.css': return 'text/css';
        case '.js': return 'application/javascript';
        case '.json': return 'application/json';
        case '.png': return 'image/png';
        case '.jpg': case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.svg': return 'image/svg+xml';
        case '.webp': return 'image/webp';
        case '.mp4': return 'video/mp4';
        case '.webm': return 'video/webm';
        case '.mov': return 'video/quicktime';
        case '.mkv': return 'video/x-matroska';
        case '.avi': return 'video/x-msvideo';
        case '.mp3': return 'audio/mpeg';
        case '.wav': return 'audio/wav';
        case '.ogg': return 'audio/ogg';
        case '.m4a': return 'audio/mp4';
        case '.flac': return 'audio/flac';
        case '.aac': return 'audio/aac';
        case '.pdf': return 'application/pdf';
        default: return 'application/octet-stream';
    }
}

const sseScript = () => `
<script>
    (function() {
        const eventSource = new EventSource('/change-sse');
        eventSource.onmessage = function(event) {
            if (event.data === 'reload') {
                window.location.reload();
            }
        };
    })();
</script>
`;

const inspectorScript = ``;

function parseMarkdownForServer(md, fsPath) {
    const escapedMd = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        <!-- Load marked.js for real-time client-side parsing -->
        <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js"></script>
        <style>
            body { 
                font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; 
                line-height: 1.6; 
                color: #e2e8f0; 
                background: #0d0f14; 
                padding: 0; 
                margin: 0; 
                display: flex; 
                flex-direction: column; 
                height: 100vh; 
            }
            .toolbar {
                position: sticky;
                top: 0;
                height: 44px;
                background: rgba(11, 15, 25, 0.9);
                backdrop-filter: blur(12px);
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 20px;
                z-index: 100;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            }
            .toolbar-title { font-size: 12px; font-weight: 600; color: #94a3b8; }
            .toolbar-actions { display: flex; align-items: center; gap: 10px; }
            .btn {
                background: transparent;
                border: none;
                color: #cbd5e1;
                cursor: pointer;
                padding: 5px 12px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: all 0.2s;
                font-size: 12px;
                font-family: inherit;
                outline: none;
                border: 1px solid rgba(255, 255, 255, 0.05);
            }
            .btn:hover {
                color: #00f0ff;
                background: rgba(255, 255, 255, 0.05);
                border-color: rgba(0, 240, 255, 0.2);
            }
            .btn-primary {
                background: linear-gradient(135deg, #00f0ff, #3b82f6);
                color: #05070f;
                font-weight: 600;
                border: none;
            }
            .btn-primary:hover {
                color: #05070f;
                transform: scale(1.02);
                box-shadow: 0 0 12px rgba(0, 240, 255, 0.3);
            }
            .content-container {
                flex: 1;
                overflow-y: auto;
                padding: 32px;
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
                align-items: center;
            }
            .markdown-body {
                width: 100%;
                max-width: 800px;
                text-align: left;
            }
            .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
                color: #00f0ff;
                border-bottom: 1px solid rgba(255,255,255,0.08);
                padding-bottom: 8px;
                margin-top: 24px;
                margin-bottom: 16px;
            }
            .markdown-body p { margin-bottom: 16px; color: #cbd5e1; line-height: 1.7; }
            .markdown-body pre { background: #161b22; border: 1px solid rgba(255,255,255,0.08); padding: 16px; border-radius: 8px; overflow-x: auto; margin-bottom: 16px; }
            .markdown-body code { font-family: ui-monospace, monospace; color: #a5b4fc; background: rgba(110, 118, 129, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 85%; }
            .markdown-body pre code { background: transparent; padding: 0; color: #cbd5e1; font-size: 100%; }
            .markdown-body blockquote { border-left: 4px solid #3b82f6; padding-left: 16px; color: #94a3b8; font-style: italic; margin: 16px 0; }
            .markdown-body ul, .markdown-body ol { padding-left: 24px; margin-bottom: 16px; }
            .markdown-body li { margin-bottom: 6px; color: #cbd5e1; }
            .markdown-body table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
            .markdown-body th, .markdown-body td { padding: 8px 12px; border: 1px solid rgba(255, 255, 255, 0.1); }
            .markdown-body th { background: rgba(0, 240, 255, 0.05); color: #00f0ff; }
            
            /* Editor Styles */
            .editor-container {
                width: 100%;
                max-width: 800px;
                height: calc(100vh - 120px);
                display: none;
                flex-direction: column;
                gap: 16px;
            }
            textarea {
                flex: 1;
                width: 100%;
                height: 100%;
                background: #0b0f19;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                color: #cbd5e1;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
                font-size: 13px;
                padding: 16px;
                resize: none;
                outline: none;
                line-height: 1.5;
            }
            textarea:focus {
                border-color: rgba(0, 240, 255, 0.5);
                box-shadow: 0 0 10px rgba(0, 240, 255, 0.1);
            }
            .save-status {
                font-size: 12px;
                color: #34d399;
                display: none;
            }
        </style>
    </head>
    <body>
        <div class="toolbar">
            <div class="toolbar-title">${path.basename(fsPath)}</div>
            <div class="toolbar-actions">
                <span class="save-status" id="save-status">Saved!</span>
                <button class="btn" id="btn-toggle-mode">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    <span id="mode-text">Edit Markdown</span>
                </button>
                <button class="btn btn-primary" id="btn-save" style="display:none;">Save</button>
            </div>
        </div>
        
        <div class="content-container">
            <div class="markdown-body" id="preview-area"></div>
            <div class="editor-container" id="editor-area">
                <textarea id="markdown-textarea">${escapedMd}</textarea>
            </div>
        </div>

        <script>
            const btnToggleMode = document.getElementById('btn-toggle-mode');
            const btnSave = document.getElementById('btn-save');
            const previewArea = document.getElementById('preview-area');
            const editorArea = document.getElementById('editor-area');
            const textarea = document.getElementById('markdown-textarea');
            const modeText = document.getElementById('mode-text');
            const saveStatus = document.getElementById('save-status');
            
            let editMode = false;
            
            function updatePreview() {
                previewArea.innerHTML = marked.parse(textarea.value);
            }
            
            // Initial render
            updatePreview();
            
            // Real-time render while editing
            textarea.oninput = updatePreview;
            
            btnToggleMode.onclick = () => {
                editMode = !editMode;
                if (editMode) {
                    previewArea.style.display = 'none';
                    editorArea.style.display = 'flex';
                    btnSave.style.display = 'flex';
                    modeText.innerText = 'Preview Mode';
                    textarea.focus();
                } else {
                    previewArea.style.display = 'block';
                    editorArea.style.display = 'none';
                    btnSave.style.display = 'none';
                    modeText.innerText = 'Edit Markdown';
                }
            };
            
            btnSave.onclick = () => {
                const content = textarea.value;
                window.parent.postMessage({
                    command: 'saveMarkdownFile',
                    content: content
                }, '*');
                
                saveStatus.style.display = 'inline';
                setTimeout(() => {
                    saveStatus.style.display = 'none';
                }, 1500);
            };

            // Double click preview to edit
            previewArea.ondblclick = () => {
                btnToggleMode.click();
            };

            // SSE Reload event source (disabled during active editing to prevent state reset)
            (function() {
                const eventSource = new EventSource('/change-sse');
                eventSource.onmessage = function(event) {
                    if (event.data === 'reload') {
                        if (!editMode) {
                            window.location.reload();
                        }
                    }
                };
            })();
        </script>
    </body>
    </html>
    `;
}

function formatXmlForServer(xml) {
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
    <body>
        <pre><code>${escaped}</code></pre>
    </body>
    </html>
    `;
}

function formatCsvForServer(csv, sep) {
    const lines = csv.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length === 0) return '<p>Empty dataset</p>';
    
    let finalSep = sep;
    if (sep !== ',') {
        const firstLine = lines[0];
        const semicolons = (firstLine.match(/;/g) || []).length;
        const tabs = (firstLine.match(/\t/g) || []).length;
        const spaces = (firstLine.match(/ {2,}/g) || []).length;
        
        if (tabs > semicolons && tabs > spaces) {
            finalSep = '\t';
        } else if (spaces > semicolons && spaces > tabs) {
            finalSep = /\s+/;
        } else {
            finalSep = ';';
        }
    }
    
    let html = '<table>';
    lines.forEach((line, index) => {
        const cols = line.split(finalSep);
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
    <body>
        ${html}
    </body>
    </html>
    `;
}

function getImageHtmlForServer(fsPath) {
    const imgSrc = `/${encodeURIComponent(fsPath.replace(/\\/g, '/'))}?raw=true`;
    
    let fileSizeStr = '0 Bytes';
    let fileModifiedStr = 'N/A';
    try {
        if (fs.existsSync(fsPath)) {
            const stat = fs.statSync(fsPath);
            fileSizeStr = formatBytes(stat.size);
            fileModifiedStr = stat.mtime.toLocaleString();
        }
    } catch (e) {
        console.error(e);
    }

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            body { margin:0; padding:0; background:#05070f; height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; font-family:'Plus Jakarta Sans', sans-serif; color:#fff; user-select:none; }
            .img-viewport { flex:1; width:100%; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; cursor:grab; }
            .img-viewport:active { cursor:grabbing; }
            img { max-width:90%; max-height:90%; object-fit:contain; transition:transform 0.1s ease; transform-origin:center center; }
            .controls { position:fixed; bottom:24px; background:rgba(20, 20, 30, 0.85); backdrop-filter:blur(12px); border:1px solid rgba(255, 255, 255, 0.1); padding:8px 16px; border-radius:9999px; display:flex; gap:16px; align-items:center; box-shadow:0 10px 30px rgba(0,0,0,0.5); z-index: 50; }
            button { background:transparent; border:none; color:#00f0ff; font-size:18px; cursor:pointer; font-weight:700; width:32px; height:32px; display:flex; align-items:center; justify-content:center; border-radius:50%; transition:background 0.2s; outline:none; }
            button:hover { background:rgba(255, 255, 255, 0.1); }
            .zoom-level { font-family:monospace; font-size:12px; min-width:48px; text-align:center; color:#cbd5e1; }
            
            /* File Info Overlay Styling */
            .info-toggle-btn {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                background: rgba(20, 20, 30, 0.85);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #00f0ff;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                transition: all 0.2s;
                z-index: 1000;
                outline: none;
            }
            .info-toggle-btn:hover {
                background: rgba(0, 240, 255, 0.1);
                border-color: #00f0ff;
                box-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
            }
            .info-panel {
                position: fixed;
                top: 64px;
                right: 20px;
                width: 280px;
                background: rgba(11, 15, 25, 0.9);
                backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.6);
                display: none;
                flex-direction: column;
                gap: 8px;
                font-size: 11px;
                color: #cbd5e1;
                z-index: 1000;
                text-align: left;
            }
            .info-title {
                font-size: 12px;
                font-weight: 700;
                color: #fff;
                margin-bottom: 4px;
                border-bottom: 1px solid rgba(255,255,255,0.08);
                padding-bottom: 6px;
            }
            .info-row {
                display: flex;
                justify-content: space-between;
                line-height: 1.4;
            }
            .info-label {
                color: #64748b;
                font-weight: 500;
            }
        </style>
    </head>
    <body>
        <div class="img-viewport" id="viewport"><img src="${imgSrc}" id="preview-image" /></div>
        <div class="controls">
            <button id="btn-zoom-out">-</button>
            <span class="zoom-level" id="zoom-text">100%</span>
            <button id="btn-zoom-in">+</button>
            <button id="btn-reset" style="font-size:11px;">Reset</button>
        </div>
        
        <button class="info-toggle-btn" id="info-toggle-btn" title="Toggle File Info">i</button>
        <div class="info-panel" id="info-panel">
            <div class="info-title">File Information</div>
            <div class="info-row"><span class="info-label">Name:</span> <span>${path.basename(fsPath)}</span></div>
            <div class="info-row"><span class="info-label">Size:</span> <span>${fileSizeStr}</span></div>
            <div class="info-row"><span class="info-label">Dimensions:</span> <span id="info-dims">Loading...</span></div>
            <div class="info-row"><span class="info-label">Modified:</span> <span>${fileModifiedStr}</span></div>
        </div>

        <script>
            let scale = 1, posX = 0, posY = 0, isDragging = false, startX, startY;
            const img = document.getElementById('preview-image');
            const viewport = document.getElementById('viewport');
            const zoomText = document.getElementById('zoom-text');
            const infoBtn = document.getElementById('info-toggle-btn');
            const infoPanel = document.getElementById('info-panel');
            const infoDims = document.getElementById('info-dims');
            
            document.getElementById('btn-zoom-in').onclick = () => zoom(0.15);
            document.getElementById('btn-zoom-out').onclick = () => zoom(-0.15);
            document.getElementById('btn-reset').onclick = () => { scale = 1; posX = 0; posY = 0; updateTransform(); };
            
            function zoom(amount) { scale = Math.max(0.15, Math.min(8, scale + amount)); updateTransform(); }
            function updateTransform() { img.style.transform = "translate(" + posX + "px, " + posY + "px) scale(" + scale + ")"; zoomText.textContent = Math.round(scale * 100) + '%'; }
            
            viewport.onmousedown = (e) => { if (e.button !== 0) return; isDragging = true; startX = e.clientX - posX; startY = e.clientY - posY; e.preventDefault(); };
            window.onmousemove = (e) => { if (!isDragging) return; posX = e.clientX - startX; posY = e.clientY - startY; updateTransform(); };
            window.onmouseup = () => { isDragging = false; };
            viewport.onwheel = (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 0.1 : -0.1); };
            
            // Image natural dimensions display
            if (img && infoDims) {
                img.onload = () => {
                    infoDims.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' px';
                };
            }
            if (infoBtn && infoPanel) {
                infoBtn.onclick = (e) => {
                    e.stopPropagation();
                    infoPanel.style.display = infoPanel.style.display === 'flex' ? 'none' : 'flex';
                };
            }
        </script>
    </body>
    </html>
    `;
}

function getVideoHtmlForServer(fsPath) {
    const videoSrc = `/${encodeURIComponent(fsPath.replace(/\\/g, '/'))}?raw=true`;
    
    let fileSizeStr = '0 Bytes';
    let fileModifiedStr = 'N/A';
    try {
        if (fs.existsSync(fsPath)) {
            const stat = fs.statSync(fsPath);
            fileSizeStr = formatBytes(stat.size);
            fileModifiedStr = stat.mtime.toLocaleString();
        }
    } catch (e) {
        console.error(e);
    }

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            body { margin: 0; padding: 0; background: #05070f; height: 100vh; display: flex; align-items: center; justify-content: center; font-family: 'Plus Jakarta Sans', sans-serif; overflow: hidden; }
            .video-container { position: relative; width: 90%; max-width: 960px; max-height: 90%; border-radius: 16px; overflow: hidden; background: #000; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7); border: 1px solid rgba(255, 255, 255, 0.08); display: flex; align-items: center; justify-content: center; }
            video { width: 100%; height: 100%; object-fit: contain; display: block; }
            .play-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.3); opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 5; }
            .play-overlay-btn { width: 72px; height: 72px; border-radius: 50%; background: rgba(0, 240, 255, 0.2); border: 2px solid #00f0ff; backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; color: #00f0ff; box-shadow: 0 0 30px rgba(0, 240, 255, 0.3); transform: scale(0.8); transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
            .video-container:hover .play-overlay { opacity: 1; }
            .controls-container { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, rgba(5, 7, 15, 0.95) 0%, rgba(5, 7, 15, 0.4) 70%, transparent 100%); padding: 40px 20px 20px 20px; opacity: 0; transform: translateY(10px); transition: opacity 0.3s, transform 0.3s; z-index: 10; }
            .video-container:hover .controls-container, .controls-container:focus-within { opacity: 1; transform: translateY(0); }
            .progress-bar-container { position: relative; width: 100%; height: 6px; background: rgba(255, 255, 255, 0.1); border-radius: 3px; cursor: pointer; margin-bottom: 16px; transition: height 0.1s; }
            .progress-bar-container:hover { height: 8px; }
            .progress-filled { height: 100%; width: 0%; background: linear-gradient(90deg, #00f0ff, #3b82f6); border-radius: 3px; position: relative; }
            .progress-knob { position: absolute; right: -6px; top: 50%; transform: translateY(-50%) scale(0); width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 0 10px #00f0ff; transition: transform 0.1s; }
            .progress-bar-container:hover .progress-knob { transform: translateY(-50%) scale(1); }
            .control-buttons { display: flex; align-items: center; justify-content: space-between; }
            .controls-left, .controls-right { display: flex; align-items: center; gap: 16px; }
            button { background: transparent; border: none; color: #cbd5e1; cursor: pointer; padding: 4px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; outline: none; }
            button:hover { color: #00f0ff; background: rgba(255, 255, 255, 0.05); }
            button svg { width: 20px; height: 20px; }
            .volume-container { display: flex; align-items: center; gap: 8px; }
            .volume-slider { width: 60px; height: 4px; accent-color: #00f0ff; cursor: pointer; transition: width 0.2s; }
            .volume-container:hover .volume-slider { width: 80px; }
            .time-display { font-family: monospace; font-size: 13px; color: #94a3b8; }
            .speed-select { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #cbd5e1; border-radius: 6px; padding: 4px 8px; font-size: 11px; outline: none; cursor: pointer; }
            .speed-select option { background: #0b0f19; color: #cbd5e1; }
            
            /* File Info Overlay Styling */
            .info-toggle-btn {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                background: rgba(20, 20, 30, 0.85);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #00f0ff;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                transition: all 0.2s;
                z-index: 1000;
                outline: none;
            }
            .info-toggle-btn:hover {
                background: rgba(0, 240, 255, 0.1);
                border-color: #00f0ff;
                box-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
            }
            .info-panel {
                position: fixed;
                top: 64px;
                right: 20px;
                width: 280px;
                background: rgba(11, 15, 25, 0.9);
                backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.6);
                display: none;
                flex-direction: column;
                gap: 8px;
                font-size: 11px;
                color: #cbd5e1;
                z-index: 1000;
                text-align: left;
            }
            .info-title {
                font-size: 12px;
                font-weight: 700;
                color: #fff;
                margin-bottom: 4px;
                border-bottom: 1px solid rgba(255,255,255,0.08);
                padding-bottom: 6px;
            }
            .info-row {
                display: flex;
                justify-content: space-between;
                line-height: 1.4;
            }
            .info-label {
                color: #64748b;
                font-weight: 500;
            }
        </style>
    </head>
    <body>
        <div class="video-container" id="container">
            <video id="player" src="${videoSrc}" crossorigin="anonymous" preload="metadata" autoplay></video>
            <div class="play-overlay" id="overlay">
                <div class="play-overlay-btn" id="overlay-btn">
                    <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>
            </div>
            <div class="controls-container">
                <div class="progress-bar-container" id="progress-container">
                    <div class="progress-filled" id="progress-bar"><div class="progress-knob"></div></div>
                </div>
                <div class="control-buttons">
                    <div class="controls-left">
                        <button id="play-btn" title="Play/Pause">
                            <svg id="play-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            <svg id="pause-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                        </button>
                        <button id="skip-back" title="Rewind 10s">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16.1A5 5 0 0 1 5.9 20M2 20h5m-5 0V15m9-10V3L3.8 8 11 13V8.1A5 5 0 0 1 14.9 12"/></svg>
                        </button>
                        <button id="skip-forward" title="Forward 10s">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.1A5 5 0 0 0 18.1 20M22 20h-5m5 0V15m-9-10V3l7.2 5-7.2 5V8.1A5 5 0 0 0 9.1 12"/></svg>
                        </button>
                        <div class="volume-container">
                            <button id="mute-btn" title="Mute/Unmute">
                                <svg id="vol-high" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                                <svg id="vol-mute" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                            </button>
                            <input type="range" class="volume-slider" id="volume" min="0" max="1" step="0.05" value="1">
                        </div>
                        <span class="time-display" id="time-display">0:00 / 0:00</span>
                    </div>
                    <div class="controls-right">
                        <select class="speed-select" id="speed" title="Playback Speed">
                            <option value="0.5">0.5x</option>
                            <option value="0.75">0.75x</option>
                            <option value="1" selected>1.0x</option>
                            <option value="1.25">1.25x</option>
                            <option value="1.5">1.5x</option>
                            <option value="2">2.0x</option>
                        </select>
                        <button id="pip-btn" title="Picture in Picture">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><rect x="13" y="13" width="9" height="9" rx="2" ry="2"/></svg>
                        </button>
                        <button id="fs-btn" title="Toggle Fullscreen">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
        
        <button class="info-toggle-btn" id="info-toggle-btn" title="Toggle Video Info">i</button>
        <div class="info-panel" id="info-panel">
            <div class="info-title">Video Information</div>
            <div class="info-row"><span class="info-label">Name:</span> <span>${path.basename(fsPath)}</span></div>
            <div class="info-row"><span class="info-label">Size:</span> <span>${fileSizeStr}</span></div>
            <div class="info-row"><span class="info-label">Resolution:</span> <span id="info-dims">Loading...</span></div>
            <div class="info-row"><span class="info-label">Duration:</span> <span id="info-duration">Loading...</span></div>
            <div class="info-row"><span class="info-label">Modified:</span> <span>${fileModifiedStr}</span></div>
        </div>

        <script>
            const container = document.getElementById('container');
            const video = document.getElementById('player');
            const overlay = document.getElementById('overlay');
            const overlayBtn = document.getElementById('overlay-btn');
            const playBtn = document.getElementById('play-btn');
            const playIcon = document.getElementById('play-icon');
            const pauseIcon = document.getElementById('pause-icon');
            const skipBack = document.getElementById('skip-back');
            const skipForward = document.getElementById('skip-forward');
            const muteBtn = document.getElementById('mute-btn');
            const volHigh = document.getElementById('vol-high');
            const volMute = document.getElementById('vol-mute');
            const volumeSlider = document.getElementById('volume');
            const progressContainer = document.getElementById('progress-container');
            const progressBar = document.getElementById('progress-bar');
            const timeDisplay = document.getElementById('time-display');
            const speedSelect = document.getElementById('speed');
            const pipBtn = document.getElementById('pip-btn');
            const fsBtn = document.getElementById('fs-btn');
            const infoBtn = document.getElementById('info-toggle-btn');
            const infoPanel = document.getElementById('info-panel');
            const infoDims = document.getElementById('info-dims');
            const infoDuration = document.getElementById('info-duration');

            function togglePlay() {
                if (video.paused) {
                    video.play().catch(err => console.log(err));
                } else {
                    video.pause();
                }
            }
            
            playBtn.onclick = togglePlay;
            container.onclick = (e) => {
                if (e.target === video || e.target === overlay || e.target === overlayBtn) {
                    togglePlay();
                }
            };
            
            video.onplay = () => {
                playIcon.style.display = 'none';
                pauseIcon.style.display = 'block';
                overlay.style.opacity = 0;
            };
            
            video.onpause = () => {
                playIcon.style.display = 'block';
                pauseIcon.style.display = 'none';
                overlay.style.opacity = 1;
            };
            
            video.onended = () => {
                playIcon.style.display = 'block';
                pauseIcon.style.display = 'none';
                overlay.style.opacity = 1;
            };
            
            skipBack.onclick = () => video.currentTime = Math.max(0, video.currentTime - 10);
            skipForward.onclick = () => video.currentTime = Math.min(video.duration, video.currentTime + 10);

            function toggleMute() {
                video.muted = !video.muted;
                if (video.muted) {
                    volHigh.style.display = 'none';
                    volMute.style.display = 'block';
                    volumeSlider.value = 0;
                } else {
                    volHigh.style.display = 'block';
                    volMute.style.display = 'none';
                    volumeSlider.value = video.volume;
                }
            }
            muteBtn.onclick = toggleMute;
            volumeSlider.oninput = (e) => {
                video.volume = parseFloat(e.target.value);
                if (video.volume === 0) {
                    video.muted = true;
                    volHigh.style.display = 'none';
                    volMute.style.display = 'block';
                } else {
                    video.muted = false;
                    volHigh.style.display = 'block';
                    volMute.style.display = 'none';
                }
            };
            speedSelect.onchange = (e) => { video.playbackRate = parseFloat(e.target.value); };
            video.ontimeupdate = () => {
                if (video.duration) {
                    const pct = (video.currentTime / video.duration) * 100;
                    progressBar.style.width = pct + '%';
                    timeDisplay.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
                }
            };
            progressContainer.onclick = (e) => {
                const rect = progressContainer.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                video.currentTime = pct * video.duration;
            };
            function formatTime(s) {
                const h = Math.floor(s / 3600);
                const m = Math.floor((s % 3600) / 60);
                const sec = Math.floor(s % 60);
                if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
                return m + ':' + (sec < 10 ? '0' : '') + sec;
            }
            function toggleFullscreen() {
                if (!document.fullscreenElement) {
                    container.requestFullscreen().catch(err => console.log(err));
                } else {
                    document.exitFullscreen();
                }
            }
            fsBtn.onclick = toggleFullscreen;
            container.ondblclick = toggleFullscreen;
            pipBtn.onclick = async () => {
                try {
                    if (video !== document.pictureInPictureElement) await video.requestPictureInPicture();
                    else await document.exitPictureInPicture();
                } catch (error) { console.log(error); }
            };
            window.addEventListener('keydown', (e) => {
                if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
                else if (e.code === 'ArrowRight') video.currentTime = Math.min(video.duration, video.currentTime + 5);
                else if (e.code === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
                else if (e.code === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); volumeSlider.value = video.volume; }
                else if (e.code === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); volumeSlider.value = video.volume; }
            });
            
            infoBtn.onclick = (e) => {
                e.stopPropagation();
                infoPanel.style.display = infoPanel.style.display === 'flex' ? 'none' : 'flex';
            };
            
            video.onloadedmetadata = () => {
                infoDims.textContent = video.videoWidth + ' × ' + video.videoHeight + ' px';
                infoDuration.textContent = formatTime(video.duration);
                timeDisplay.textContent = '0:00 / ' + formatTime(video.duration);
            };
        </script>
    </body>
    </html>
    `;
}

function getAudioHtmlForServer(fsPath) {
    const audioSrc = `/${encodeURIComponent(fsPath.replace(/\\/g, '/'))}?raw=true`;
    const trackTitle = path.basename(fsPath);
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            body { margin: 0; padding: 0; background: #05070f; height: 100vh; display: flex; align-items: center; justify-content: center; font-family: 'Plus Jakarta Sans', sans-serif; overflow: hidden; }
            .audio-card { width: 80%; max-width: 480px; background: rgba(11, 15, 25, 0.6); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; padding: 32px; box-shadow: 0 30px 60px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; align-items: center; gap: 24px; }
            .visualizer-container { width: 100%; height: 120px; background: rgba(0, 0, 0, 0.2); border-radius: 16px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.04); position: relative; }
            canvas { width: 100%; height: 100%; display: block; }
            .track-info { text-align: center; width: 100%; }
            .track-title { font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .track-artist { font-size: 13px; color: #94a3b8; }
            .timeline-container { width: 100%; display: flex; flex-direction: column; gap: 8px; }
            .progress-bar-container { width: 100%; height: 6px; background: rgba(255, 255, 255, 0.1); border-radius: 3px; cursor: pointer; position: relative; }
            .progress-filled { height: 100%; width: 0%; background: linear-gradient(90deg, #00f0ff, #3b82f6); border-radius: 3px; position: relative; }
            .progress-knob { position: absolute; right: -6px; top: 50%; transform: translateY(-50%) scale(0); width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 0 10px #00f0ff; transition: transform 0.1s; }
            .progress-bar-container:hover .progress-knob { transform: translateY(-50%) scale(1); }
            .time-row { display: flex; justify-content: space-between; font-size: 11px; font-family: monospace; color: #64748b; }
            .controls { display: flex; align-items: center; justify-content: center; gap: 24px; width: 100%; }
            button { background: transparent; border: none; color: #cbd5e1; cursor: pointer; padding: 8px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: all 0.2s; outline: none; }
            button:hover { color: #00f0ff; background: rgba(255, 255, 255, 0.05); }
            .play-btn-main { width: 56px; height: 56px; background: linear-gradient(135deg, #00f0ff, #3b82f6); color: #05070f; box-shadow: 0 8px 20px rgba(0, 240, 255, 0.3); }
            .play-btn-main:hover { color: #05070f; transform: scale(1.05); box-shadow: 0 10px 25px rgba(0, 240, 255, 0.4); background: linear-gradient(135deg, #00f0ff, #3b82f6); }
            .play-btn-main svg { width: 24px; height: 24px; }
            .volume-row { display: flex; align-items: center; gap: 8px; width: 120px; }
            .volume-slider { flex: 1; height: 4px; accent-color: #00f0ff; cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="audio-card">
            <div class="visualizer-container"><canvas id="visualizer"></canvas></div>
            <div class="track-info">
                <div class="track-title" id="track-title">${trackTitle}</div>
                <div class="track-artist">Audio File Preview</div>
            </div>
            <div class="timeline-container">
                <div class="progress-bar-container" id="progress-container">
                    <div class="progress-filled" id="progress-bar"><div class="progress-knob"></div></div>
                </div>
                <div class="time-row">
                    <span id="time-current">0:00</span>
                    <span id="time-duration">0:00</span>
                </div>
            </div>
            <div class="controls">
                <div class="volume-row">
                    <button id="mute-btn" title="Mute/Unmute">
                        <svg id="vol-high" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
                        <svg id="vol-mute" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:none;"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v-2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3z"/></svg>
                    </button>
                    <input type="range" class="volume-slider" id="volume" min="0" max="1" step="0.05" value="1">
                </div>
                <button class="play-btn-main" id="play-btn" title="Play/Pause">
                    <svg id="play-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <svg id="pause-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <div style="width:120px; display:flex; justify-content:flex-end;">
                    <select id="speed" style="background:transparent; border:1px solid rgba(255,255,255,0.1); color:#cbd5e1; border-radius:6px; padding:4px 8px; font-size:11px; outline:none; cursor:pointer;">
                        <option value="0.5">0.5x</option>
                        <option value="1" selected>1.0x</option>
                        <option value="1.5">1.5x</option>
                        <option value="2">2.0x</option>
                    </select>
                </div>
            </div>
        </div>
        <audio id="audio-element" src="${audioSrc}" crossorigin="anonymous"></audio>
        <script>
            const audio = document.getElementById('audio-element');
            const playBtn = document.getElementById('play-btn');
            const playIcon = document.getElementById('play-icon');
            const pauseIcon = document.getElementById('pause-icon');
            const muteBtn = document.getElementById('mute-btn');
            const volHigh = document.getElementById('vol-high');
            const volMute = document.getElementById('vol-mute');
            const volumeSlider = document.getElementById('volume');
            const progressContainer = document.getElementById('progress-container');
            const progressBar = document.getElementById('progress-bar');
            const timeCurrent = document.getElementById('time-current');
            const timeDuration = document.getElementById('time-duration');
            const speedSelect = document.getElementById('speed');
            const canvas = document.getElementById('visualizer');
            const ctx = canvas.getContext('2d');
            
            let audioCtx = null;
            let analyser = null;
            let source = null;
            let dataArray = [];
            let bufferLength = 0;
            
            function resizeCanvas() {
                canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
                canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
                ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            }
            window.addEventListener('resize', resizeCanvas);
            resizeCanvas();
            
            function initAudioAnalyzer() {
                if (audioCtx) return;
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                bufferLength = analyser.frequencyBinCount;
                dataArray = new Uint8Array(bufferLength);
                source = audioCtx.createMediaElementSource(audio);
                source.connect(analyser);
                analyser.connect(audioCtx.destination);
            }
            
            function drawVisualizer() {
                requestAnimationFrame(drawVisualizer);
                const width = canvas.width / window.devicePixelRatio;
                const height = canvas.height / window.devicePixelRatio;
                ctx.clearRect(0, 0, width, height);
                
                if (!analyser) {
                    ctx.beginPath();
                    ctx.moveTo(0, height / 2);
                    ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
                    ctx.lineWidth = 2;
                    for (let i = 0; i < width; i++) {
                        const y = height / 2 + Math.sin(i * 0.05) * 5;
                        ctx.lineTo(i, y);
                    }
                    ctx.stroke();
                    return;
                }
                
                analyser.getByteFrequencyData(dataArray);
                ctx.strokeStyle = 'rgba(0, 240, 255, 0.8)';
                ctx.shadowBlur = 10;
                ctx.shadowColor = '#00f0ff';
                ctx.lineWidth = 3;
                
                const barWidth = (width / bufferLength) * 1.5;
                let barHeight;
                let x = 0;
                ctx.beginPath();
                ctx.moveTo(0, height / 2);
                for (let i = 0; i < bufferLength; i++) {
                    barHeight = (dataArray[i] / 255) * (height / 1.6);
                    const y = i % 2 === 0 ? (height / 2 - barHeight) : (height / 2 + barHeight);
                    ctx.lineTo(x, y);
                    x += barWidth;
                }
                ctx.lineTo(width, height / 2);
                ctx.stroke();
                ctx.shadowBlur = 0;
            }
            drawVisualizer();
            
            function togglePlay() {
                if (audio.paused) {
                    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
                    else initAudioAnalyzer();
                    audio.play().catch(err => console.log(err));
                } else {
                    audio.pause();
                }
            }
            playBtn.onclick = togglePlay;
            
            audio.onplay = () => {
                playIcon.style.display = 'none';
                pauseIcon.style.display = 'block';
            };
            audio.onpause = () => {
                playIcon.style.display = 'block';
                pauseIcon.style.display = 'none';
            };
            audio.onended = () => {
                playIcon.style.display = 'block';
                pauseIcon.style.display = 'none';
            };
            muteBtn.onclick = () => {
                audio.muted = !audio.muted;
                if (audio.muted) {
                    volHigh.style.display = 'none';
                    volMute.style.display = 'block';
                    volumeSlider.value = 0;
                } else {
                    volHigh.style.display = 'block';
                    volMute.style.display = 'none';
                    volumeSlider.value = audio.volume;
                }
            };
            volumeSlider.oninput = (e) => {
                audio.volume = e.target.value;
                if (audio.volume === 0) {
                    audio.muted = true;
                    volHigh.style.display = 'none';
                    volMute.style.display = 'block';
                } else {
                    audio.muted = false;
                    volHigh.style.display = 'block';
                    volMute.style.display = 'none';
                }
            };
            speedSelect.onchange = (e) => { audio.playbackRate = parseFloat(e.target.value); };
            audio.ontimeupdate = () => {
                if (audio.duration) {
                    const pct = (audio.currentTime / audio.duration) * 100;
                    progressBar.style.width = pct + '%';
                    timeCurrent.textContent = formatTime(audio.currentTime);
                    timeDuration.textContent = formatTime(audio.duration);
                }
            };
            progressContainer.onclick = (e) => {
                const rect = progressContainer.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                audio.currentTime = pct * audio.duration;
            };
            function formatTime(s) {
                const m = Math.floor(s / 60);
                const sec = Math.floor(s % 60);
                return m + ':' + (sec < 10 ? '0' : '') + sec;
            }
        </script>
    </body>
    </html>
    `;
}

function getPdfHtmlForServer(fsPath) {
    const pdfSrc = `/${encodeURIComponent(fsPath.replace(/\\/g, '/'))}?raw=true`;
    const fileName = path.basename(fsPath);
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            body {
                margin: 0;
                padding: 0;
                background: #0d0f14;
                height: 100vh;
                width: 100vw;
                display: flex;
                font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                overflow: hidden;
                color: #cbd5e1;
            }
            .pdf-app-container {
                display: flex;
                width: 100%;
                height: 100%;
                overflow: hidden;
                position: relative;
            }
            
            /* Left Sidebar Styling */
            .pdf-sidebar {
                width: 200px;
                min-width: 200px;
                background: #08090d;
                border-right: 1px solid rgba(255, 255, 255, 0.06);
                display: flex;
                flex-direction: column;
                height: 100%;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                z-index: 10;
            }
            .pdf-sidebar.collapsed {
                width: 0px;
                min-width: 0px;
                border-right: none;
                overflow: hidden;
            }
            .sidebar-header {
                padding: 14px 16px;
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #94a3b8;
                border-bottom: 1px solid rgba(255, 255, 255, 0.04);
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .sidebar-list {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 16px;
            }
            .thumb-container {
                background: #11131a;
                border: 2px solid transparent;
                border-radius: 6px;
                padding: 8px;
                cursor: pointer;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 6px;
                transition: all 0.2s ease;
            }
            .thumb-container:hover {
                background: #161a24;
                border-color: rgba(0, 240, 255, 0.2);
            }
            .thumb-container.active {
                background: #1a2233;
                border-color: #00f0ff;
                box-shadow: 0 0 12px rgba(0, 240, 255, 0.15);
            }
            .thumb-canvas {
                max-width: 100%;
                height: auto;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.4);
                background: #fff;
                border-radius: 2px;
            }
            .thumb-label {
                font-size: 11px;
                font-weight: 600;
                color: #94a3b8;
            }
            .thumb-container.active .thumb-label {
                color: #00f0ff;
            }
            
            /* Main Content View */
            .pdf-main {
                flex: 1;
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
                position: relative;
            }
            
            /* Toolbar Styling */
            .toolbar {
                height: 48px;
                min-height: 48px;
                background: rgba(15, 18, 25, 0.9);
                backdrop-filter: blur(12px);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 16px;
                z-index: 20;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            }
            .toolbar-left, .toolbar-middle, .toolbar-right {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .toolbar-middle {
                position: absolute;
                left: 50%;
                transform: translateX(-50%);
            }
            .btn {
                background: transparent;
                border: 1px solid rgba(255, 255, 255, 0.04);
                color: #cbd5e1;
                cursor: pointer;
                width: 32px;
                height: 32px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                outline: none;
            }
            .btn:hover {
                color: #00f0ff;
                background: rgba(255, 255, 255, 0.05);
                border-color: rgba(0, 240, 255, 0.2);
            }
            .btn.active {
                color: #00f0ff;
                background: rgba(0, 240, 255, 0.1);
                border-color: rgba(0, 240, 255, 0.3);
            }
            .btn:disabled {
                color: #4b5563;
                cursor: not-allowed;
                background: transparent;
                border-color: transparent;
            }
            .toolbar-divider {
                width: 1px;
                height: 20px;
                background: rgba(255, 255, 255, 0.08);
                margin: 0 4px;
            }
            .page-nav-container {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 13px;
                color: #94a3b8;
            }
            .page-num-input {
                width: 38px;
                height: 24px;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                color: #fff;
                text-align: center;
                font-size: 13px;
                font-family: inherit;
                outline: none;
                transition: all 0.2s;
            }
            .page-num-input:focus {
                border-color: #00f0ff;
                background: rgba(255, 255, 255, 0.08);
            }
            /* Remove number input arrows */
            .page-num-input::-webkit-outer-spin-button,
            .page-num-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }
            
            .zoom-select {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 6px;
                color: #cbd5e1;
                height: 28px;
                padding: 0 8px;
                outline: none;
                font-size: 12px;
                font-family: inherit;
                cursor: pointer;
                transition: all 0.2s;
            }
            .zoom-select:hover {
                border-color: rgba(255, 255, 255, 0.2);
            }
            .zoom-select:focus {
                border-color: #00f0ff;
            }
            .zoom-select option {
                background: #14161f;
                color: #cbd5e1;
            }
            
            /* Search Bar styling */
            .search-bar {
                display: none;
                align-items: center;
                gap: 6px;
                background: rgba(20, 22, 31, 0.95);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 6px;
                padding: 6px 10px;
                position: absolute;
                top: 54px;
                left: 16px;
                z-index: 30;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
                backdrop-filter: blur(8px);
            }
            .search-bar.visible {
                display: flex;
            }
            .search-bar input {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                color: #fff;
                outline: none;
                font-size: 12px;
                width: 140px;
                padding: 4px 8px;
            }
            .search-bar span {
                font-size: 11px;
                color: #64748b;
                margin-right: 4px;
            }
            
            /* PDF Viewer Main container */
            .pdf-viewer-container {
                flex: 1;
                width: 100%;
                overflow: auto;
                display: flex;
                box-sizing: border-box;
                background: #0b0c10;
                position: relative;
            }
            .pdf-viewer-container.hand-tool {
                cursor: grab;
            }
            .pdf-viewer-container.hand-tool:active {
                cursor: grabbing;
            }
            .pdf-viewer-container.draw-tool {
                cursor: crosshair;
            }
            
            /* Page layouts mapping */
            .pdf-viewer-container.scroll-vertical {
                flex-direction: column;
                align-items: center;
                padding: 24px;
                gap: 24px;
            }
            .pdf-viewer-container.scroll-horizontal {
                flex-direction: row;
                align-items: center;
                padding: 24px;
                gap: 24px;
            }
            .pdf-viewer-container.scroll-wrapped {
                flex-direction: row;
                flex-wrap: wrap;
                justify-content: center;
                align-content: flex-start;
                padding: 24px;
                gap: 24px;
            }
            
            /* CSS Grid Spreads for Vertical Scroll */
            .pdf-viewer-container.scroll-vertical.spread-odd {
                display: grid !important;
                grid-template-columns: repeat(2, max-content) !important;
                justify-content: center !important;
                align-items: start !important;
                gap: 24px !important;
            }
            .pdf-viewer-container.scroll-vertical.spread-odd .pdf-page-wrapper:first-child {
                grid-column: 1 / span 2;
                justify-self: center;
            }
            .pdf-viewer-container.scroll-vertical.spread-even {
                display: grid !important;
                grid-template-columns: repeat(2, max-content) !important;
                justify-content: center !important;
                align-items: start !important;
                gap: 24px !important;
            }
            
            /* Page Wrapper Styling */
            .pdf-page-wrapper {
                flex-shrink: 0;
                background: #fff;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
                border-radius: 4px;
                overflow: hidden;
                position: relative;
                display: flex;
                flex-direction: column;
                align-items: center;
                transition: outline 0.15s;
            }
            .pdf-page-wrapper.active-page {
                outline: 2px solid #00f0ff;
            }
            canvas {
                display: block;
            }
            
            /* Options Menu panel */
            .options-menu {
                position: absolute;
                top: 52px;
                right: 16px;
                width: 240px;
                background: #12141c;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
                z-index: 100;
                display: none;
                flex-direction: column;
                overflow-y: auto;
                max-height: calc(100vh - 80px);
                padding: 6px 0;
            }
            .options-menu.visible {
                display: flex;
            }
            .menu-header {
                padding: 6px 16px;
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #64748b;
                background: rgba(255, 255, 255, 0.01);
                margin: 4px 0;
            }
            .menu-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 8px 16px;
                color: #cbd5e1;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .menu-item:hover {
                background: rgba(0, 240, 255, 0.08);
                color: #00f0ff;
            }
            .menu-item svg {
                color: #94a3b8;
                transition: color 0.15s;
            }
            .menu-item:hover svg {
                color: #00f0ff;
            }
            .menu-divider {
                height: 1px;
                background: rgba(255, 255, 255, 0.06);
                margin: 6px 0;
            }
            .menu-item.active {
                color: #00f0ff;
                font-weight: 600;
                background: rgba(0, 240, 255, 0.03);
            }
            .menu-item.active svg {
                color: #00f0ff;
            }
            
            .loading-indicator {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                font-size: 14px;
                color: #00f0ff;
                font-weight: 600;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 12px;
                z-index: 50;
            }
            .spinner {
                width: 28px;
                height: 28px;
                border: 2px solid rgba(0, 240, 255, 0.15);
                border-top-color: #00f0ff;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
            
            /* Print overrides */
            @media print {
                body * {
                    visibility: hidden;
                }
                #viewer-container, #viewer-container canvas {
                    visibility: visible;
                }
                #viewer-container {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 100%;
                    overflow: visible;
                }
            }
        </style>
        <!-- Load PDF.js -->
        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js"></script>
    </head>
    <body>
        <div class="pdf-app-container">
            <!-- Sidebar with page thumbnails -->
            <div class="pdf-sidebar" id="sidebar">
                <div class="sidebar-header">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                    Page Previews
                </div>
                <div class="sidebar-list" id="sidebar-list"></div>
            </div>
            
            <!-- Main Content Area -->
            <div class="pdf-main">
                <!-- Top Toolbar -->
                <div class="toolbar">
                    <div class="toolbar-left">
                        <button class="btn active" id="toggle-sidebar" title="Toggle Sidebar">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
                        </button>
                        <button class="btn" id="btn-search" title="Search Document">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                        </button>
                        <div class="toolbar-divider"></div>
                        <div class="page-nav-container">
                            <button class="btn" id="prev-page" title="Previous Page">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
                            </button>
                            <input type="number" class="page-num-input" id="page-num-input" value="1" min="1">
                            <span id="page-total-label">of -</span>
                            <button class="btn" id="next-page" title="Next Page">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                            </button>
                        </div>
                    </div>
                    
                    <div class="toolbar-middle">
                        <button class="btn" id="zoom-out" title="Zoom Out">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        </button>
                        <select class="zoom-select" id="zoom-select">
                            <option value="auto">Automatic Zoom</option>
                            <option value="page">Fit Page</option>
                            <option value="width">Fit Width</option>
                            <option value="0.5">50%</option>
                            <option value="0.75">75%</option>
                            <option value="1.0">100%</option>
                            <option value="1.25" selected>125%</option>
                            <option value="1.5">150%</option>
                            <option value="2.0">200%</option>
                            <option value="3.0">300%</option>
                            <option value="4.0">400%</option>
                            <option value="custom" disabled hidden>Custom</option>
                        </select>
                        <button class="btn" id="zoom-in" title="Zoom In">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        </button>
                    </div>
                    
                    <div class="toolbar-right">
                        <!-- Scroll Layout Controls -->
                        <button class="btn" id="btn-scroll-vert" title="Vertical Scroll (Top to Bottom)">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
                        </button>
                        <button class="btn" id="btn-scroll-horiz" title="Horizontal Scroll (Left to Right)">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                        </button>
                        <div class="toolbar-divider"></div>
                        <!-- Ink & Drawing tools -->
                        <button class="btn" id="tool-draw" title="Draw Ink Overlay">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        <div class="toolbar-divider"></div>
                        <button class="btn" id="btn-print" title="Print Document">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
                        </button>
                        <button class="btn" id="btn-download" title="Download PDF">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                        </button>
                        <button class="btn" id="menu-toggle" title="More Options">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>
                        </button>
                    </div>
                </div>
                
                <!-- Search panel overlay -->
                <div class="search-bar" id="search-bar">
                    <input type="text" id="search-input" placeholder="Search page numbers...">
                    <button class="btn" id="search-btn-action" style="width:26px; height:26px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                </div>
                
                <!-- Options dropdown overlay -->
                <div class="options-menu" id="options-menu">
                    <div class="menu-item" id="menu-open">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        Open File
                    </div>
                    <div class="menu-divider"></div>
                    <div class="menu-item" id="menu-first">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 18 11 12 17 6"/><line x1="7" y1="6" x2="7" y2="18"/></svg>
                        Go to First Page
                    </div>
                    <div class="menu-item" id="menu-last">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="7 18 13 12 7 6"/><line x1="17" y1="6" x2="17" y2="18"/></svg>
                        Go to Last Page
                    </div>
                    <div class="menu-divider"></div>
                    <div class="menu-item" id="menu-rotate-cw">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                        Rotate Clockwise
                    </div>
                    <div class="menu-item" id="menu-rotate-ccw">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-8.38L2.5 8"/></svg>
                        Rotate Counterclockwise
                    </div>
                    <div class="menu-divider"></div>
                    <div class="menu-item active" id="menu-tool-select">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="m12 12 9 9-4-10-5-5-5 5"/></svg>
                        Text Selection Tool
                    </div>
                    <div class="menu-item" id="menu-tool-hand">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v5"/><path d="M14 10V5a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v5"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M6 14v4a4 4 0 0 0 4 4h5a5 5 0 0 0 5-5v-6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v3"/></svg>
                        Hand Tool
                    </div>
                    <div class="menu-divider"></div>
                    <div class="menu-header">Page Scrolling</div>
                    <div class="menu-item active" id="menu-scroll-vert">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
                        Vertical Scrolling
                    </div>
                    <div class="menu-item" id="menu-scroll-horiz">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                        Horizontal Scrolling
                    </div>
                    <div class="menu-item" id="menu-scroll-wrap">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
                        Wrapped Scrolling
                    </div>
                    <div class="menu-divider"></div>
                    <div class="menu-header">Spreads</div>
                    <div class="menu-item active" id="menu-spread-none">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="12" height="16" rx="2"/></svg>
                        No Spreads
                    </div>
                    <div class="menu-item" id="menu-spread-odd">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="9" height="16" rx="1"/><rect x="13" y="4" width="9" height="16" rx="1"/></svg>
                        Odd Spreads
                    </div>
                    <div class="menu-item" id="menu-spread-even">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/></svg>
                        Even Spreads
                    </div>
                </div>
                
                <!-- Main Viewer Box -->
                <div class="pdf-viewer-container scroll-vertical" id="viewer-container">
                    <div class="loading-indicator" id="loading">
                        <div class="spinner"></div>
                        Loading PDF Document...
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Hidden Open File dialog helper -->
        <input type="file" id="file-input-helper" accept="application/pdf" style="display:none;">
        
        <script>
            // Set PDF.js worker source
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
            
            let pdfDoc = null;
            let scale = 1.25;
            let rotation = 0;
            let currentPage = 1;
            
            let currentScrollMode = 'vertical'; // vertical, horizontal, wrapped
            let currentSpreadMode = 'none'; // none, odd, even
            let currentTool = 'select'; // select, hand, draw
            
            const url = '${pdfSrc}';
            const canvasContainer = document.getElementById('viewer-container');
            const loadingIndicator = document.getElementById('loading');
            
            const zoomInBtn = document.getElementById('zoom-in');
            const zoomOutBtn = document.getElementById('zoom-out');
            const zoomSelect = document.getElementById('zoom-select');
            
            const toggleSidebarBtn = document.getElementById('toggle-sidebar');
            const sidebar = document.getElementById('sidebar');
            const pageInput = document.getElementById('page-num-input');
            const pageCountText = document.getElementById('page-total-label');
            
            const prevPageBtn = document.getElementById('prev-page');
            const nextPageBtn = document.getElementById('next-page');
            
            const menuToggleBtn = document.getElementById('menu-toggle');
            const optionsMenu = document.getElementById('options-menu');
            
            // Tool/menu refs
            const toolDrawBtn = document.getElementById('tool-draw');
            const btnScrollVert = document.getElementById('btn-scroll-vert');
            const btnScrollHoriz = document.getElementById('btn-scroll-horiz');
            const btnSearch = document.getElementById('btn-search');
            const searchBar = document.getElementById('search-bar');
            const searchInput = document.getElementById('search-input');
            const searchBtnAction = document.getElementById('search-btn-action');
            
            // 1. Core PDF loader
            function loadPdf(pdfUrl) {
                loadingIndicator.style.display = 'flex';
                pdfjsLib.getDocument(pdfUrl).promise.then(pdfDoc_ => {
                    pdfDoc = pdfDoc_;
                    pageCountText.textContent = 'of ' + pdfDoc.numPages;
                    pageInput.max = pdfDoc.numPages;
                    loadingIndicator.style.display = 'none';
                    
                    currentPage = 1;
                    rotation = 0;
                    renderAllPages();
                    renderThumbnails();
                }).catch(err => {
                    console.error('Error loading PDF:', err);
                    loadingIndicator.innerHTML = '<span style="color:#ff4a4a; font-weight:700;">Error: ' + err.message + '</span>';
                });
            }
            
            // 2. Render all pages to canvas
            function renderAllPages() {
                const wrappers = canvasContainer.querySelectorAll('.pdf-page-wrapper');
                wrappers.forEach(w => w.remove());
                
                if (!pdfDoc) return;
                
                for (let i = 1; i <= pdfDoc.numPages; i++) {
                    const pageWrapper = document.createElement('div');
                    pageWrapper.className = 'pdf-page-wrapper';
                    pageWrapper.id = 'page-wrapper-' + i;
                    pageWrapper.dataset.pageNum = i;
                    
                    const canvas = document.createElement('canvas');
                    canvas.id = 'canvas-' + i;
                    pageWrapper.appendChild(canvas);
                    
                    canvasContainer.appendChild(pageWrapper);
                    renderPage(i, canvas);
                }
                
                updateActivePage(currentPage);
            }
            
            // 3. Render a single page at current zoom & rotation
            function renderPage(num, canvas) {
                pdfDoc.getPage(num).then(page => {
                    const viewport = page.getViewport({ scale: scale, rotation: rotation });
                    const ctx = canvas.getContext('2d');
                    
                    const dpr = window.devicePixelRatio || 1;
                    canvas.height = viewport.height * dpr;
                    canvas.width = viewport.width * dpr;
                    canvas.style.height = viewport.height + 'px';
                    canvas.style.width = viewport.width + 'px';
                    
                    ctx.scale(dpr, dpr);
                    
                    const renderContext = {
                        canvasContext: ctx,
                        viewport: viewport
                    };
                    
                    page.render(renderContext).promise.then(() => {
                        setupDrawingForCanvas(canvas, num);
                    });
                });
            }
            
            // 4. Thumbnail Sidebar Generator
            function renderThumbnails() {
                const sidebarList = document.getElementById('sidebar-list');
                sidebarList.innerHTML = '';
                
                for (let i = 1; i <= pdfDoc.numPages; i++) {
                    const thumbContainer = document.createElement('div');
                    thumbContainer.className = 'thumb-container';
                    thumbContainer.id = 'thumb-container-' + i;
                    thumbContainer.dataset.pageNum = i;
                    
                    const canvas = document.createElement('canvas');
                    canvas.className = 'thumb-canvas';
                    canvas.id = 'thumb-canvas-' + i;
                    
                    const label = document.createElement('div');
                    label.className = 'thumb-label';
                    label.textContent = 'Page ' + i;
                    
                    thumbContainer.appendChild(canvas);
                    thumbContainer.appendChild(label);
                    sidebarList.appendChild(thumbContainer);
                    
                    thumbContainer.onclick = () => {
                        jumpToPage(i);
                    };
                    
                    renderThumbnailPage(i, canvas);
                }
            }
            
            function renderThumbnailPage(num, canvas) {
                pdfDoc.getPage(num).then(page => {
                    const viewport = page.getViewport({ scale: 0.18, rotation: rotation });
                    const ctx = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    
                    const renderContext = {
                        canvasContext: ctx,
                        viewport: viewport
                    };
                    page.render(renderContext);
                });
            }
            
            // 5. Jump page helper
            function jumpToPage(num) {
                const targetPage = document.getElementById('page-wrapper-' + num);
                if (targetPage) {
                    if (currentScrollMode === 'horizontal') {
                        const offset = targetPage.offsetLeft - 20;
                        canvasContainer.scrollTo({
                            left: offset,
                            behavior: 'smooth'
                        });
                    } else {
                        const offset = targetPage.offsetTop - 20;
                        canvasContainer.scrollTo({
                            top: offset,
                            behavior: 'smooth'
                        });
                    }
                    updateActivePage(num);
                }
            }
            
            // 6. Update Active Page highlighting and synchronization
            function updateActivePage(pageNum) {
                currentPage = pageNum;
                pageInput.value = pageNum;
                
                // Outline active page
                const wrappers = canvasContainer.querySelectorAll('.pdf-page-wrapper');
                wrappers.forEach(w => {
                    w.classList.toggle('active-page', parseInt(w.dataset.pageNum) === pageNum);
                });
                
                // Highlight active thumbnail
                const thumbs = document.querySelectorAll('.thumb-container');
                thumbs.forEach(t => {
                    t.classList.toggle('active', parseInt(t.dataset.pageNum) === pageNum);
                });
                
                const activeThumb = document.getElementById('thumb-container-' + pageNum);
                if (activeThumb && sidebar.offsetWidth > 0) {
                    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
            
            // 7. Dynamic scale calculation for fitting viewport
            function calculateScale(zoomType) {
                if (!pdfDoc) return Promise.resolve(scale);
                return pdfDoc.getPage(1).then(page => {
                    const viewport = page.getViewport({ scale: 1.0, rotation: rotation });
                    const containerWidth = canvasContainer.clientWidth - 48;
                    const containerHeight = canvasContainer.clientHeight - 48;
                    
                    let targetScale = 1.25;
                    if (zoomType === 'width') {
                        targetScale = containerWidth / viewport.width;
                    } else if (zoomType === 'page') {
                        targetScale = containerHeight / viewport.height;
                    } else if (zoomType === 'auto') {
                        targetScale = Math.min(containerWidth / viewport.width, 1.3);
                    } else {
                        targetScale = parseFloat(zoomType);
                    }
                    return Math.max(0.25, Math.min(5.0, targetScale));
                });
            }
            
            function applyZoom(zoomType) {
                calculateScale(zoomType).then(newScale => {
                    scale = newScale;
                    renderAllPages();
                });
            }
            
            // 8. Sidebar action
            toggleSidebarBtn.onclick = () => {
                sidebar.classList.toggle('collapsed');
                toggleSidebarBtn.classList.toggle('active');
                setTimeout(() => {
                    if (['auto', 'page', 'width'].includes(zoomSelect.value)) {
                        applyZoom(zoomSelect.value);
                    }
                }, 260);
            };
            
            // 9. Navigation Actions
            prevPageBtn.onclick = () => {
                if (currentPage > 1) jumpToPage(currentPage - 1);
            };
            nextPageBtn.onclick = () => {
                if (currentPage < pdfDoc.numPages) jumpToPage(currentPage + 1);
            };
            pageInput.onchange = (e) => {
                let val = parseInt(e.target.value);
                if (isNaN(val) || val < 1) val = 1;
                if (val > pdfDoc.numPages) val = pdfDoc.numPages;
                jumpToPage(val);
            };
            
            // 10. Zoom dropdown and buttons
            zoomSelect.onchange = (e) => {
                applyZoom(e.target.value);
            };
            zoomInBtn.onclick = () => {
                scale = Math.min(5.0, scale + 0.25);
                zoomSelect.value = 'custom';
                const customOption = zoomSelect.querySelector('option[value="custom"]');
                customOption.textContent = Math.round(scale * 100) + '%';
                renderAllPages();
            };
            zoomOutBtn.onclick = () => {
                scale = Math.max(0.25, scale - 0.25);
                zoomSelect.value = 'custom';
                const customOption = zoomSelect.querySelector('option[value="custom"]');
                customOption.textContent = Math.round(scale * 100) + '%';
                renderAllPages();
            };
            
            // 11. Search overlay actions
            btnSearch.onclick = () => {
                searchBar.classList.toggle('visible');
                if (searchBar.classList.contains('visible')) {
                    searchInput.focus();
                }
            };
            searchBtnAction.onclick = () => {
                const val = parseInt(searchInput.value);
                if (!isNaN(val) && val >= 1 && val <= pdfDoc.numPages) {
                    jumpToPage(val);
                }
            };
            searchInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    searchBtnAction.click();
                }
            };
            
            // 12. More options menu
            menuToggleBtn.onclick = (e) => {
                e.stopPropagation();
                optionsMenu.classList.toggle('visible');
            };
            document.addEventListener('click', (e) => {
                if (!optionsMenu.contains(e.target) && e.target !== menuToggleBtn) {
                    optionsMenu.classList.remove('remove');
                    optionsMenu.classList.remove('visible');
                }
            });
            
            // 13. Options Menu callbacks
            document.getElementById('menu-first').onclick = () => {
                optionsMenu.classList.remove('visible');
                jumpToPage(1);
            };
            document.getElementById('menu-last').onclick = () => {
                optionsMenu.classList.remove('visible');
                jumpToPage(pdfDoc.numPages);
            };
            document.getElementById('menu-rotate-cw').onclick = () => {
                optionsMenu.classList.remove('visible');
                rotation = (rotation + 90) % 360;
                renderAllPages();
                renderThumbnails();
            };
            document.getElementById('menu-rotate-ccw').onclick = () => {
                optionsMenu.classList.remove('visible');
                rotation = (rotation + 270) % 360;
                renderAllPages();
                renderThumbnails();
            };
            
            // Open local PDF file
            document.getElementById('menu-open').onclick = () => {
                optionsMenu.classList.remove('visible');
                document.getElementById('file-input-helper').click();
            };
            document.getElementById('file-input-helper').onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const objectUrl = URL.createObjectURL(file);
                    loadPdf(objectUrl);
                }
            };
            
            // Layout modes settings
            function updateViewerLayout() {
                canvasContainer.className = 'pdf-viewer-container';
                
                // Scroll mode
                if (currentScrollMode === 'vertical') {
                    canvasContainer.classList.add('scroll-vertical');
                } else if (currentScrollMode === 'horizontal') {
                    canvasContainer.classList.add('scroll-horizontal');
                } else if (currentScrollMode === 'wrapped') {
                    canvasContainer.classList.add('scroll-wrapped');
                }
                
                // Spread layout (only valid in vertical and wrapped mode)
                if (currentScrollMode !== 'horizontal') {
                    if (currentSpreadMode === 'odd') {
                        canvasContainer.classList.add('spread-odd');
                    } else if (currentSpreadMode === 'even') {
                        canvasContainer.classList.add('spread-even');
                    }
                }
                
                // Tool settings
                if (currentTool === 'hand') {
                    canvasContainer.classList.add('hand-tool');
                } else if (currentTool === 'draw') {
                    canvasContainer.classList.add('draw-tool');
                }
                
                updateOptionsMenuActiveStates();
                
                // Recalculate zoom fitting when layout changes
                if (['auto', 'page', 'width'].includes(zoomSelect.value)) {
                    applyZoom(zoomSelect.value);
                }
            }
            
            function updateOptionsMenuActiveStates() {
                document.getElementById('menu-scroll-vert').classList.toggle('active', currentScrollMode === 'vertical');
                document.getElementById('menu-scroll-horiz').classList.toggle('active', currentScrollMode === 'horizontal');
                document.getElementById('menu-scroll-wrap').classList.toggle('active', currentScrollMode === 'wrapped');
                
                btnScrollVert.classList.toggle('active', currentScrollMode === 'vertical');
                btnScrollHoriz.classList.toggle('active', currentScrollMode === 'horizontal');
                
                document.getElementById('menu-spread-none').classList.toggle('active', currentSpreadMode === 'none');
                document.getElementById('menu-spread-odd').classList.toggle('active', currentSpreadMode === 'odd');
                document.getElementById('menu-spread-even').classList.toggle('active', currentSpreadMode === 'even');
                
                document.getElementById('menu-tool-select').classList.toggle('active', currentTool === 'select');
                document.getElementById('menu-tool-hand').classList.toggle('active', currentTool === 'hand');
                toolDrawBtn.classList.toggle('active', currentTool === 'draw');
            }
            
            // Bind toolbar scrolling triggers
            btnScrollVert.onclick = () => {
                currentScrollMode = 'vertical';
                updateViewerLayout();
            };
            btnScrollHoriz.onclick = () => {
                currentScrollMode = 'horizontal';
                updateViewerLayout();
            };
            
            // Bind scrolling menu triggers
            document.getElementById('menu-scroll-vert').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentScrollMode = 'vertical';
                updateViewerLayout();
            };
            document.getElementById('menu-scroll-horiz').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentScrollMode = 'horizontal';
                updateViewerLayout();
            };
            document.getElementById('menu-scroll-wrap').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentScrollMode = 'wrapped';
                updateViewerLayout();
            };
            
            document.getElementById('menu-spread-none').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentSpreadMode = 'none';
                updateViewerLayout();
            };
            document.getElementById('menu-spread-odd').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentSpreadMode = 'odd';
                updateViewerLayout();
            };
            document.getElementById('menu-spread-even').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentSpreadMode = 'even';
                updateViewerLayout();
            };
            
            document.getElementById('menu-tool-select').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentTool = 'select';
                updateViewerLayout();
            };
            document.getElementById('menu-tool-hand').onclick = () => {
                optionsMenu.classList.remove('visible');
                currentTool = 'hand';
                updateViewerLayout();
            };
            toolDrawBtn.onclick = () => {
                if (currentTool === 'draw') {
                    currentTool = 'select';
                } else {
                    currentTool = 'draw';
                }
                updateViewerLayout();
            };
            
            // 14. Hand Tool click-and-drag panning implementation
            let isDragging = false;
            let startX, startY, scrollLeft, scrollTop;
            
            canvasContainer.addEventListener('mousedown', (e) => {
                if (currentTool !== 'hand') return;
                isDragging = true;
                startX = e.pageX - canvasContainer.offsetLeft;
                startY = e.pageY - canvasContainer.offsetTop;
                scrollLeft = canvasContainer.scrollLeft;
                scrollTop = canvasContainer.scrollTop;
            });
            canvasContainer.addEventListener('mouseleave', () => {
                isDragging = false;
            });
            canvasContainer.addEventListener('mouseup', () => {
                isDragging = false;
            });
            canvasContainer.addEventListener('mousemove', (e) => {
                if (!isDragging || currentTool !== 'hand') return;
                e.preventDefault();
                const x = e.pageX - canvasContainer.offsetLeft;
                const y = e.pageY - canvasContainer.offsetTop;
                const walkX = (x - startX) * 1.5;
                const walkY = (y - startY) * 1.5;
                canvasContainer.scrollLeft = scrollLeft - walkX;
                canvasContainer.scrollTop = scrollTop - walkY;
            });
            
            // 15. Canvas Ink overlay sketching function
            function setupDrawingForCanvas(canvas, pageNum) {
                const ctx = canvas.getContext('2d');
                let drawing = false;
                let lastX = 0;
                let lastY = 0;
                
                canvas.addEventListener('mousedown', (e) => {
                    if (currentTool !== 'draw') return;
                    drawing = true;
                    
                    const rect = canvas.getBoundingClientRect();
                    const scaleX = canvas.width / rect.width;
                    const scaleY = canvas.height / rect.height;
                    
                    lastX = (e.clientX - rect.left) * scaleX;
                    lastY = (e.clientY - rect.top) * scaleY;
                });
                
                canvas.addEventListener('mousemove', (e) => {
                    if (!drawing || currentTool !== 'draw') return;
                    const rect = canvas.getBoundingClientRect();
                    const scaleX = canvas.width / rect.width;
                    const scaleY = canvas.height / rect.height;
                    
                    const x = (e.clientX - rect.left) * scaleX;
                    const y = (e.clientY - rect.top) * scaleY;
                    
                    ctx.strokeStyle = '#00f0ff';
                    ctx.lineWidth = 3 * scaleX;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    
                    ctx.beginPath();
                    ctx.moveTo(lastX, lastY);
                    ctx.lineTo(x, y);
                    ctx.stroke();
                    
                    lastX = x;
                    lastY = y;
                });
                
                canvas.addEventListener('mouseup', () => drawing = false);
                canvas.addEventListener('mouseleave', () => drawing = false);
            }
            
            // 16. Intersection observer scroll track
            canvasContainer.addEventListener('scroll', () => {
                const wrappers = canvasContainer.querySelectorAll('.pdf-page-wrapper');
                let inViewPage = currentPage;
                let minDiff = Infinity;
                
                if (currentScrollMode === 'horizontal') {
                    const containerLeft = canvasContainer.scrollLeft;
                    wrappers.forEach(w => {
                        const pNum = parseInt(w.dataset.pageNum);
                        const diff = Math.abs(w.offsetLeft - containerLeft - 24);
                        if (diff < minDiff) {
                            minDiff = diff;
                            inViewPage = pNum;
                        }
                    });
                } else {
                    const containerTop = canvasContainer.scrollTop;
                    wrappers.forEach(w => {
                        const pNum = parseInt(w.dataset.pageNum);
                        const diff = Math.abs(w.offsetTop - containerTop - 24);
                        if (diff < minDiff) {
                            minDiff = diff;
                            inViewPage = pNum;
                        }
                    });
                }
                
                if (inViewPage !== currentPage) {
                    updateActivePage(inViewPage);
                }
            });
            
            // Print & Download binds
            document.getElementById('btn-print').onclick = () => window.print();
            document.getElementById('btn-download').onclick = () => {
                const a = document.createElement('a');
                a.href = url;
                a.download = '${fileName}';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            };
            
            // Initial load
            loadPdf(url);
            updateViewerLayout();
        </script>
    </body>
    </html>
    `;
}

function activate(context) {
    console.log('Live Preview HTML extension is active.');

    // Create and configure VS Code Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'htmlpreview-vscode.openPreview';
    statusBarItem.text = '$(play) Live Preview HTML';
    statusBarItem.tooltip = 'Show Live Preview HTML';
    context.subscriptions.push(statusBarItem);

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

    let openPreviewDisposable = vscode.commands.registerCommand('htmlpreview-vscode.openPreview', async (uri, selectedUris) => {
        if (selectedUris && selectedUris.length > 1) {
            for (const u of selectedUris) {
                await openPreviewForUri(u, context);
            }
        } else {
            let fileUri = uri;
            if (!fileUri && vscode.window.activeTextEditor) {
                fileUri = vscode.window.activeTextEditor.document.uri;
            }
            await openPreviewForUri(fileUri, context);
        }
    });

    context.subscriptions.push(openPreviewDisposable);

    // Watch for document changes (live sync typing)
    const changeDocDisposable = vscode.workspace.onDidChangeTextDocument(e => {
        const filePath = e.document.uri.fsPath.replace(/\\/g, '/');
        
        activePreviews.forEach((preview) => {
            if (preview.filePath.toLowerCase() === filePath.toLowerCase()) {
                if (debounceTimers.has(String(preview.port))) {
                    clearTimeout(debounceTimers.get(String(preview.port)));
                }
                const timer = setTimeout(() => {
                    triggerSseReload(preview);
                    debounceTimers.delete(String(preview.port));
                }, 150);
                debounceTimers.set(String(preview.port), timer);
            }
        });

        // Live refresh HTML previews if workspace CSS changes
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.css' || ext === '.js') {
            activePreviews.forEach((preview) => {
                const previewExt = path.extname(preview.filePath).toLowerCase();
                if (previewExt === '.html' || previewExt === '.htm') {
                    if (debounceTimers.has(String(preview.port))) {
                        clearTimeout(debounceTimers.get(String(preview.port)));
                    }
                    const timer = setTimeout(() => {
                        triggerSseReload(preview);
                        debounceTimers.delete(String(preview.port));
                    }, 150);
                    debounceTimers.set(String(preview.port), timer);
                }
            });
        }
    });

    context.subscriptions.push(changeDocDisposable);

    // Watch for saves
    const saveDocDisposable = vscode.workspace.onDidSaveTextDocument(doc => {
        const filePath = doc.uri.fsPath.replace(/\\/g, '/');
        activePreviews.forEach((preview) => {
            if (preview.filePath.toLowerCase() === filePath.toLowerCase()) {
                triggerSseReload(preview);
            }
        });
        
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.css' || ext === '.js') {
            activePreviews.forEach((preview) => {
                const previewExt = path.extname(preview.filePath).toLowerCase();
                if (previewExt === '.html' || previewExt === '.htm') {
                    triggerSseReload(preview);
                }
            });
        }
    });

    context.subscriptions.push(saveDocDisposable);
}

async function openPreviewForUri(fileUri, context) {
    if (!fileUri) {
        vscode.window.showErrorMessage('No file selected to preview.');
        return;
    }

    const filePath = fileUri.fsPath.replace(/\\/g, '/');

    // Allocate a unique port starting from 3006
    const port = await findAvailablePort(3006);
    const fileName = path.basename(filePath);

    const panel = vscode.window.createWebviewPanel(
        'htmlPreview.preview',
        `Preview: ${fileName}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    const entry = { panel, filePath, port, server: null, sseClients: [] };
    activePreviews.set(String(port), entry);

    // Start dedicated server for this preview instance
    createServerForPreview(entry, port);

    // Initial load of wrapper HTML
    updateWebviewWrapper(entry);

    // Broadcast updated active preview servers to all panels
    updateAllWebviews();

    // Message receiver from webview wrapper
    panel.webview.onDidReceiveMessage(message => {
        if (message.command === 'loadPath') {
            let pathRaw = message.path.trim();
            
            // Check if it is an external web URL
            const isWebUrl = /^(https?:\/\/)/i.test(pathRaw) && 
                             !pathRaw.startsWith(`http://127.0.0.1:${port}/`) &&
                             !pathRaw.startsWith(`http://localhost:${port}/`);
            
            if (isWebUrl) {
                entry.filePath = pathRaw;
                panel.title = `Preview: Web`;
                updateWebviewWrapper(entry);
                updateAllWebviews();
            } else {
                // If they entered the local server URL, strip it back to file path
                const localhostPrefix = `http://127.0.0.1:${port}/`;
                const localHostPrefix2 = `http://localhost:${port}/`;
                if (pathRaw.startsWith(localhostPrefix)) {
                    pathRaw = decodeURIComponent(pathRaw.replace(localhostPrefix, ''));
                } else if (pathRaw.startsWith(localHostPrefix2)) {
                    pathRaw = decodeURIComponent(pathRaw.replace(localHostPrefix2, ''));
                } else if (pathRaw.startsWith('http://127.0.0.1:')) {
                    const urlMatch = pathRaw.match(/http:\/\/127\.0\.0\.1:\d+\/(.*)/);
                    if (urlMatch) {
                        pathRaw = decodeURIComponent(urlMatch[1]);
                    }
                } else if (pathRaw.startsWith('http://localhost:')) {
                    const urlMatch = pathRaw.match(/http:\/\/localhost:\d+\/(.*)/);
                    if (urlMatch) {
                        pathRaw = decodeURIComponent(urlMatch[1]);
                    }
                }

                let resolvedPath = pathRaw.replace(/\\/g, '/');
                
                // Auto resolve relative paths
                if (!path.isAbsolute(resolvedPath)) {
                    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
                    if (workspaceFolder) {
                        resolvedPath = path.resolve(workspaceFolder.uri.fsPath, resolvedPath);
                    } else {
                        resolvedPath = path.resolve(path.dirname(entry.filePath), resolvedPath);
                    }
                }
                resolvedPath = resolvedPath.replace(/\\/g, '/');

                if (fs.existsSync(resolvedPath)) {
                    entry.filePath = resolvedPath;
                    panel.title = `Preview: ${path.basename(resolvedPath)}`;
                    updateWebviewWrapper(entry);
                    updateAllWebviews();
                } else {
                    vscode.window.showErrorMessage(`File path does not exist: ${resolvedPath}`);
                }
            }
        } else if (message.command === 'openInBrowser') {
            const isWebUrl = /^(https?:\/\/)/i.test(entry.filePath);
            const targetUrl = isWebUrl ? entry.filePath : getServerUrl(entry.filePath, entry.port);
            vscode.env.openExternal(vscode.Uri.parse(targetUrl));
        } else if (message.command === 'openDevTools') {
            vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
        } else if (message.command === 'switchInstance') {
            const targetPort = String(message.port);
            const targetEntry = activePreviews.get(targetPort);
            if (targetEntry) {
                entry.filePath = message.filePath;
                const isWebUrl = /^(https?:\/\/)/i.test(message.filePath);
                panel.title = isWebUrl ? 'Preview: Web' : `Preview: ${path.basename(message.filePath)}`;
                updateWebviewWrapper(entry);
                updateAllWebviews();
            }
        } else if (message.command === 'closeInstance') {
            const targetPort = String(message.port);
            const targetEntry = activePreviews.get(targetPort);
            if (targetEntry) {
                targetEntry.panel.dispose();
            }
        } else if (message.command === 'closeThisInstance') {
            panel.dispose();
        } else if (message.command === 'saveMarkdownFile') {
            const mdContent = message.content;
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.replace(/\\/g, '/').toLowerCase() === entry.filePath.toLowerCase());
            if (doc) {
                const edit = new vscode.WorkspaceEdit();
                const range = new vscode.Range(
                    doc.positionAt(0),
                    doc.positionAt(doc.getText().length)
                );
                edit.replace(doc.uri, range, mdContent);
                vscode.workspace.applyEdit(edit).then(() => {
                    doc.save();
                });
            } else {
                try {
                    fs.writeFileSync(entry.filePath, mdContent, 'utf8');
                    vscode.window.showInformationMessage(`Successfully saved: ${path.basename(entry.filePath)}`);
                    activePreviews.forEach((preview) => {
                        if (preview.filePath.toLowerCase() === entry.filePath.toLowerCase()) {
                            triggerSseReload(preview);
                        }
                    });
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to save file: ${err.message}`);
                }
            }
        }
    });

    panel.onDidDispose(() => {
        activePreviews.delete(String(port));
        if (entry.server) {
            try {
                entry.server.close();
            } catch (e) {}
        }
        updateAllWebviews();
    });
}

function updateWebviewWrapper(entry) {
    entry.panel.webview.html = getWrapperHtml(entry.filePath, entry.port, entry.panel.webview);
}

function getWrapperHtml(filePath, port, webview) {
    const isWebUrl = /^(https?:\/\/)/i.test(filePath) && 
                     !filePath.startsWith(`http://127.0.0.1:${port}/`) &&
                     !filePath.startsWith(`http://localhost:${port}/`);
                     
    const serverUrl = isWebUrl ? filePath : getServerUrl(filePath, port);
    const ext = isWebUrl ? '' : path.extname(filePath).toLowerCase();
    const isImage = !isWebUrl && ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext);
    const imageWebviewUri = isImage ? webview.asWebviewUri(vscode.Uri.file(filePath)).toString() : '';

    let imageSizeStr = '0 Bytes';
    let imageModifiedStr = 'N/A';
    if (isImage) {
        try {
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                imageSizeStr = formatBytes(stat.size);
                imageModifiedStr = stat.mtime.toLocaleString();
            }
        } catch (e) {
            console.error(e);
        }
    }

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
        <style>
            :root {
                --bg-color: #05070f;
                --header-bg: rgba(11, 15, 25, 0.85);
                --border-color: rgba(255, 255, 255, 0.08);
                --text-color: #cbd5e1;
                --accent-color: #00f0ff;
                --accent-gradient: linear-gradient(135deg, #00f0ff, #3b82f6);
                --card-bg: rgba(20, 20, 30, 0.6);
                --input-bg: rgba(8, 10, 16, 0.8);
                --text-muted: #64748b;
            }

            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            body {
                font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
                background: var(--bg-color);
                color: var(--text-color);
                height: 100vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            header {
                height: 48px;
                background: var(--header-bg);
                backdrop-filter: blur(12px);
                border-bottom: 1px solid var(--border-color);
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 16px;
                z-index: 100;
            }

            .header-left {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .logo {
                font-family: 'Space Grotesk', sans-serif;
                font-weight: 700;
                font-size: 13px;
                letter-spacing: 0.5px;
                color: #fff;
                white-space: nowrap;
                cursor: pointer;
                text-decoration: none;
            }
            .logo span {
                background: var(--accent-gradient);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }

            .path-container {
                display: flex;
                align-items: center;
                background: var(--input-bg);
                border: 1px solid var(--border-color);
                border-radius: 6px;
                padding: 2px 6px;
                width: 45%;
                max-width: 600px;
                transition: all 0.2s ease;
            }

            .path-container:focus-within {
                border-color: rgba(0, 240, 255, 0.5);
                box-shadow: 0 0 10px rgba(0, 240, 255, 0.15);
            }

            .path-input {
                background: transparent;
                border: none;
                color: #fff;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                font-size: 11px;
                width: 100%;
                outline: none;
                padding: 4px;
            }

            .icon-btn {
                background: transparent;
                border: none;
                color: var(--text-muted);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 6px;
                border-radius: 6px;
                transition: all 0.2s ease;
                outline: none;
            }

            .icon-btn:hover {
                color: #fff;
                background: rgba(255, 255, 255, 0.08);
            }

            .icon-btn.active {
                color: var(--accent-color);
                background: rgba(0, 240, 255, 0.1);
                border: 1px solid rgba(0, 240, 255, 0.2);
            }

            .responsive-controls {
                display: flex;
                align-items: center;
                background: rgba(0, 0, 0, 0.25);
                border: 1px solid var(--border-color);
                border-radius: 6px;
                padding: 2px;
                gap: 2px;
            }

            .custom-dims {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-left: 8px;
                display: none;
            }

            .dim-input {
                background: var(--input-bg);
                border: 1px solid var(--border-color);
                border-radius: 4px;
                color: #fff;
                width: 50px;
                text-align: center;
                font-size: 11px;
                padding: 2px;
                outline: none;
            }
            .dim-input:focus {
                border-color: var(--accent-color);
            }

            .header-right {
                display: flex;
                align-items: center;
                gap: 8px;
                position: relative;
            }

            .dropdown {
                position: absolute;
                top: 40px;
                right: 0;
                background: rgba(16, 16, 23, 0.95);
                backdrop-filter: blur(16px);
                border: 1px solid var(--border-color);
                border-radius: 8px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.5);
                width: 200px;
                display: none;
                flex-direction: column;
                padding: 4px 0;
                z-index: 1000;
            }

            .dropdown-item {
                padding: 10px 14px;
                font-size: 11px;
                color: var(--text-color);
                cursor: pointer;
                transition: all 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: 500;
            }

            .dropdown-item:hover {
                background: var(--accent-gradient);
                color: #0b0f19;
                font-weight: 700;
            }

            .dropdown-divider {
                height: 1px;
                background: rgba(255,255,255,0.08);
                margin: 4px 0;
            }

            .dropdown-header {
                font-size: 9px;
                font-weight: 700;
                color: var(--text-muted);
                padding: 4px 14px;
                text-transform: uppercase;
            }

            .workspace {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                background: radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px);
                background-size: 20px 20px;
                padding: 20px;
                overflow: auto;
                position: relative;
            }

            .iframe-container {
                width: 100%;
                height: 100%;
                transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                background: #fff;
                box-shadow: 0 15px 40px rgba(0, 0, 0, 0.5);
                border-radius: 6px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                position: relative;
            }

            .iframe-container.mode-mobile {
                width: 375px;
                height: 667px;
                border: 12px solid #1a1a1a;
                border-radius: 36px;
                box-shadow: 0 25px 60px rgba(0,0,0,0.8);
            }

            .iframe-container.mode-custom {
                width: 800px;
                height: 600px;
            }

            iframe {
                border: none;
                width: 100%;
                height: 100%;
                background: #fff;
            }

            #toast {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: var(--accent-gradient);
                color: #0b0f19;
                font-weight: 700;
                padding: 10px 18px;
                border-radius: 6px;
                font-size: 11px;
                box-shadow: 0 10px 25px rgba(0, 240, 255, 0.3);
                opacity: 0;
                transform: translateY(20px);
                transition: all 0.3s ease;
                pointer-events: none;
                z-index: 10000;
            }
            #toast.show {
                opacity: 1;
                transform: translateY(0);
            }

            /* Image Viewport styling */
            .img-viewport {
                flex: 1;
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                overflow: hidden;
                cursor: grab;
                background: #05070f;
            }
            .img-viewport:active {
                cursor: grabbing;
            }
            .img-viewport img {
                max-width: 90%;
                max-height: 90%;
                object-fit: contain;
                transition: transform 0.1s ease;
                transform-origin: center center;
            }
            .workspace-image-controls {
                position: absolute;
                bottom: 24px;
                background: rgba(20, 20, 30, 0.85);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                padding: 8px 16px;
                border-radius: 9999px;
                display: flex;
                gap: 16px;
                align-items: center;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                z-index: 50;
            }
            .workspace-image-controls button {
                background: transparent;
                border: none;
                color: #00f0ff;
                font-size: 18px;
                cursor: pointer;
                font-weight: 700;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                transition: background 0.2s;
                outline: none;
            }
            .workspace-image-controls button:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .workspace-image-controls .zoom-level {
                font-family: monospace;
                font-size: 12px;
                min-width: 48px;
                text-align: center;
                color: #cbd5e1;
            }
            
            /* File Info Overlay Styling */
            .info-toggle-btn {
                position: absolute;
                top: 20px;
                right: 20px;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                background: rgba(20, 20, 30, 0.85);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #00f0ff;
                font-family: 'Space Grotesk', monospace;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                transition: all 0.2s;
                z-index: 1000;
                outline: none;
            }
            .info-toggle-btn:hover {
                background: rgba(0, 240, 255, 0.1);
                border-color: #00f0ff;
                box-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
            }
            .info-panel {
                position: absolute;
                top: 64px;
                right: 20px;
                width: 280px;
                background: rgba(11, 15, 25, 0.9);
                backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.6);
                display: none;
                flex-direction: column;
                gap: 8px;
                font-size: 11px;
                color: #cbd5e1;
                z-index: 1000;
                text-align: left;
            }
            .info-title {
                font-size: 12px;
                font-weight: 700;
                color: #fff;
                margin-bottom: 4px;
                border-bottom: 1px solid rgba(255,255,255,0.08);
                padding-bottom: 6px;
            }
            .info-row {
                display: flex;
                justify-content: space-between;
                line-height: 1.4;
            }
            .info-label {
                color: #64748b;
                font-weight: 500;
            }
        </style>
    </head>
    <body>
        <header>
            <div class="header-left">
                <a href="https://github.com/rupesh9369" target="_blank" class="logo">Live Preview <span>HTML</span></a>
                
                <button class="icon-btn" id="btn-close-this" title="Close Preview" style="color: #ff4a4a;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
 
                <button class="icon-btn" id="btn-reload" title="Reload Preview">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
 
                <div style="position: relative; display: flex; align-items: center;">
                    <button class="icon-btn" id="btn-menu" title="Menu">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                    </button>
                    <div class="dropdown" id="menu-dropdown" style="left: 0; top: 32px; right: auto;">
                        <div class="dropdown-item" id="menu-browser">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                            Open in Browser
                        </div>
                        <div class="dropdown-item" id="menu-devpanel">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                            Open Dev Panel
                        </div>
                        <div class="dropdown-divider"></div>
                        <div class="dropdown-header">Running Servers</div>
                        <div id="running-instances-list"></div>
                    </div>
                </div>
 
                <div class="responsive-controls" style="margin-left: 8px;">
                    <button class="icon-btn active" id="btn-pc" title="Desktop View">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    </button>
                    <button class="icon-btn" id="btn-mobile" title="Mobile View">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                    </button>
                    <button class="icon-btn" id="btn-custom" title="Custom View">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6H4zm10-10h6v6h-6zm0 10h6v6h-6zM4 4h6v6H4z"/></svg>
                    </button>
                </div>
                <div class="custom-dims" id="custom-dims-container">
                    <input type="number" id="custom-w" class="dim-input" value="800" placeholder="W" title="Width">
                    <span style="font-size:10px; color:var(--text-muted);">×</span>
                    <input type="number" id="custom-h" class="dim-input" value="600" placeholder="H" title="Height">
                </div>
            </div>
 
            <div class="path-container">
                <input type="text" id="path-input" class="path-input" value="${isImage ? filePath : serverUrl}">
                <button class="icon-btn" id="btn-copy" title="Copy Path">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="icon-btn" id="btn-go" title="Load File" style="color:var(--accent-color);">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
            </div>
 
            <div class="header-right"></div>
        </header>
 
        <div class="workspace">
            <div class="iframe-container" id="iframe-container" style="${isImage ? 'background: #05070f;' : ''}">
                ${isImage ? `
                    <div class="img-viewport" id="viewport">
                        <img src="${imageWebviewUri}" id="preview-image" />
                    </div>
                    <div class="workspace-image-controls">
                        <button id="btn-zoom-out">-</button>
                        <span class="zoom-level" id="zoom-text">100%</span>
                        <button id="btn-zoom-in">+</button>
                        <button id="btn-reset" style="font-size:11px;">Reset</button>
                    </div>
                    <button class="info-toggle-btn" id="image-info-btn" title="Toggle File Info">i</button>
                    <div class="info-panel" id="image-info-panel">
                        <div class="info-title">File Information</div>
                        <div class="info-row"><span class="info-label">Name:</span> <span>${path.basename(filePath)}</span></div>
                        <div class="info-row"><span class="info-label">Size:</span> <span>${imageSizeStr}</span></div>
                        <div class="info-row"><span class="info-label">Dimensions:</span> <span id="image-info-dims">Loading...</span></div>
                        <div class="info-row"><span class="info-label">Modified:</span> <span>${imageModifiedStr}</span></div>
                    </div>
                ` : `
                    <iframe id="preview-iframe" src="${serverUrl}"></iframe>
                `}
            </div>
        </div>
 
        <div id="toast">URL copied!</div>
 
        <script>
            (function() {
                const vscode = acquireVsCodeApi();
                
                const btnPc = document.getElementById('btn-pc');
                const btnMobile = document.getElementById('btn-mobile');
                const btnCustom = document.getElementById('btn-custom');
                const iframeContainer = document.getElementById('iframe-container');
                const customDims = document.getElementById('custom-dims-container');
                const customW = document.getElementById('custom-w');
                const customH = document.getElementById('custom-h');
                
                const pathInput = document.getElementById('path-input');
                const btnCopy = document.getElementById('btn-copy');
                const btnGo = document.getElementById('btn-go');
                
                const btnCloseThis = document.getElementById('btn-close-this');
                const btnReload = document.getElementById('btn-reload');
                const btnMenu = document.getElementById('btn-menu');
                const menuDropdown = document.getElementById('menu-dropdown');
                
                const menuBrowser = document.getElementById('menu-browser');
                const menuDevPanel = document.getElementById('menu-devpanel');
                const previewIframe = document.getElementById('preview-iframe');
                
                const toast = document.getElementById('toast');
 
                // Responsive sizing
                btnPc.onclick = () => setResponsiveMode('pc');
                btnMobile.onclick = () => setResponsiveMode('mobile');
                btnCustom.onclick = () => setResponsiveMode('custom');
 
                function setResponsiveMode(mode) {
                    btnPc.classList.remove('active');
                    btnMobile.classList.remove('active');
                    btnCustom.classList.remove('active');
                    
                    iframeContainer.className = 'iframe-container';
                    customDims.style.display = 'none';
                    
                    iframeContainer.style.width = '';
                    iframeContainer.style.height = '';
 
                    if (mode === 'pc') {
                        btnPc.classList.add('active');
                    } else if (mode === 'mobile') {
                        btnMobile.classList.add('active');
                        iframeContainer.classList.add('mode-mobile');
                    } else if (mode === 'custom') {
                        btnCustom.classList.add('active');
                        iframeContainer.classList.add('mode-custom');
                        customDims.style.display = 'flex';
                        updateCustomDimensions();
                    }
                }
 
                function updateCustomDimensions() {
                    const w = parseInt(customW.value) || 800;
                    const h = parseInt(customH.value) || 600;
                    iframeContainer.style.width = w + 'px';
                    iframeContainer.style.height = h + 'px';
                }
 
                customW.oninput = updateCustomDimensions;
                customH.oninput = updateCustomDimensions;
 
                function loadPath() {
                    const pathVal = pathInput.value.trim();
                    if (pathVal) {
                        vscode.postMessage({
                            command: 'loadPath',
                            path: pathVal
                        });
                    }
                }
 
                pathInput.onkeydown = (e) => {
                    if (e.key === 'Enter') {
                        loadPath();
                    }
                };
                btnGo.onclick = loadPath;
 
                btnCopy.onclick = () => {
                    const urlVal = pathInput.value;
                    navigator.clipboard.writeText(urlVal).then(() => {
                        toast.classList.add('show');
                        setTimeout(() => {
                            toast.classList.remove('show');
                        }, 2000);
                    });
                };
 
                btnCloseThis.onclick = () => {
                    vscode.postMessage({ command: 'closeThisInstance' });
                };
 
                btnReload.onclick = () => {
                    if (previewIframe) {
                        previewIframe.src = previewIframe.src;
                    } else {
                        loadPath();
                    }
                };
 
                btnMenu.onclick = (e) => {
                    e.stopPropagation();
                    menuDropdown.style.display = menuDropdown.style.display === 'flex' ? 'none' : 'flex';
                };
 
                window.onclick = () => {
                    menuDropdown.style.display = 'none';
                };
                
                menuBrowser.onclick = () => {
                    vscode.postMessage({ command: 'openInBrowser' });
                };
 
                menuDevPanel.onclick = () => {
                    vscode.postMessage({ command: 'openDevTools' });
                };
 
                function renderInstances(instances) {
                    const container = document.getElementById('running-instances-list');
                    container.innerHTML = '';
                    
                    if (instances.length <= 1) {
                        const emptyItem = document.createElement('div');
                        emptyItem.className = 'dropdown-item';
                        emptyItem.style.color = 'var(--text-muted)';
                        emptyItem.style.fontSize = '10px';
                        emptyItem.innerText = 'No other servers running';
                        container.appendChild(emptyItem);
                        return;
                    }
                    
                    const currentPort = "${port}";
                    instances.forEach(inst => {
                        if (String(inst.port) === String(currentPort)) return;
                        
                        const item = document.createElement('div');
                        item.className = 'dropdown-item';
                        item.style.display = 'flex';
                        item.style.justifyContent = 'space-between';
                        item.style.alignItems = 'center';
                        
                        const leftSpan = document.createElement('span');
                        leftSpan.innerHTML = '⚡ Port ' + inst.port + ': ' + inst.fileName;
                        leftSpan.style.cursor = 'pointer';
                        leftSpan.style.flex = '1';
                        leftSpan.onclick = (e) => {
                            e.stopPropagation();
                            vscode.postMessage({
                                command: 'switchInstance',
                                port: inst.port,
                                filePath: inst.filePath
                            });
                        };
                        
                        const closeBtn = document.createElement('span');
                        closeBtn.innerHTML = '&times;';
                        closeBtn.style.color = 'var(--text-muted)';
                        closeBtn.style.fontSize = '14px';
                        closeBtn.style.fontWeight = '700';
                        closeBtn.style.cursor = 'pointer';
                        closeBtn.style.padding = '0 6px';
                        closeBtn.style.borderRadius = '4px';
                        closeBtn.style.transition = 'all 0.2s';
                        
                        closeBtn.onmouseover = () => {
                            closeBtn.style.color = '#ff4a4a';
                            closeBtn.style.background = 'rgba(255, 74, 74, 0.15)';
                        };
                        closeBtn.onmouseout = () => {
                            closeBtn.style.color = 'var(--text-muted)';
                            closeBtn.style.background = 'transparent';
                        };
                        
                        closeBtn.onclick = (e) => {
                            e.stopPropagation();
                            vscode.postMessage({
                                command: 'closeInstance',
                                port: inst.port
                            });
                        };
                        
                        item.appendChild(leftSpan);
                        item.appendChild(closeBtn);
                        container.appendChild(item);
                    });
                }
 
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'updateIframeSrc') {
                        if (previewIframe) {
                            previewIframe.src = message.src;
                        }
                        pathInput.value = message.src;
                    } else if (message.command === 'updateRunningInstances') {
                        renderInstances(message.instances);
                    } else if (message.command === 'saveMarkdownFile') {
                        vscode.postMessage({
                            command: 'saveMarkdownFile',
                            content: message.content
                        });
                    }
                });
 
                // Image zoom & pan script
                const img = document.getElementById('preview-image');
                const viewport = document.getElementById('viewport');
                const zoomText = document.getElementById('zoom-text');
                
                if (img && viewport && zoomText) {
                    let scale = 1, posX = 0, posY = 0, isDragging = false, startX, startY;
                    
                    document.getElementById('btn-zoom-in').onclick = () => zoom(0.15);
                    document.getElementById('btn-zoom-out').onclick = () => zoom(-0.15);
                    document.getElementById('btn-reset').onclick = () => { scale = 1; posX = 0; posY = 0; updateTransform(); };
                    
                    function zoom(amount) {
                        scale = Math.max(0.15, Math.min(8, scale + amount));
                        updateTransform();
                    }
                    function updateTransform() {
                        img.style.transform = "translate(" + posX + "px, " + posY + "px) scale(" + scale + ")";
                        zoomText.textContent = Math.round(scale * 100) + '%';
                    }
                    
                    viewport.onmousedown = (e) => {
                        if (e.button !== 0) return;
                        isDragging = true;
                        startX = e.clientX - posX;
                        startY = e.clientY - posY;
                        viewport.style.cursor = 'grabbing';
                        e.preventDefault();
                    };
                    window.onmousemove = (e) => {
                        if (!isDragging) return;
                        posX = e.clientX - startX;
                        posY = e.clientY - startY;
                        updateTransform();
                    };
                    window.onmouseup = () => {
                        isDragging = false;
                        viewport.style.cursor = 'grab';
                    };
                    viewport.onwheel = (e) => {
                        e.preventDefault();
                        zoom(e.deltaY < 0 ? 0.1 : -0.1);
                    };
                    
                    // Image info toggle
                    const imgInfoBtn = document.getElementById('image-info-btn');
                    const imgInfoPanel = document.getElementById('image-info-panel');
                    const imgInfoDims = document.getElementById('image-info-dims');
                    
                    if (imgInfoBtn && imgInfoPanel) {
                        imgInfoBtn.onclick = (e) => {
                            e.stopPropagation();
                            imgInfoPanel.style.display = imgInfoPanel.style.display === 'flex' ? 'none' : 'flex';
                        };
                    }
                    if (img && imgInfoDims) {
                        img.onload = () => {
                            imgInfoDims.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' px';
                        };
                    }
                }
            })();
        </script>
    </body>
    </html>
    `;
}

function deactivate() {
    activePreviews.forEach(p => {
        try {
            p.panel.dispose();
        } catch (e) {}
        if (p.server) {
            try {
                p.server.close();
            } catch (e) {}
        }
    });
    activePreviews.clear();
    debounceTimers.forEach(t => clearTimeout(t));
    debounceTimers.clear();
    if (statusBarItem) statusBarItem.dispose();
}

module.exports = {
    activate,
    deactivate
};

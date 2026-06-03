(function() {
    let inspectModeActive = false;
    let hoveredElement = null;

    // Track computed style properties we want to inspect
    const stylesToTrack = [
        'display', 'position', 'color', 'background-color',
        'font-size', 'font-family', 'font-weight', 'margin',
        'padding', 'border', 'width', 'height', 'opacity', 'z-index'
    ];

    // Toggle body cursor style
    function toggleInspectCursor(active) {
        if (active) {
            document.body.style.cursor = 'crosshair';
            // Disable pointer-events temporarily on iframes inside iframe if any
            document.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = 'none');
        } else {
            document.body.style.cursor = '';
            document.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = '');
        }
    }

    // Capture hover inside iframe
    document.addEventListener('mouseover', e => {
        if (!inspectModeActive) return;
        
        const target = e.target;
        if (target === document.documentElement || target === document.body) return;

        hoveredElement = target;

        const rect = target.getBoundingClientRect();
        
        let tagString = target.tagName.toLowerCase();
        if (target.id) {
            tagString += `#${target.id}`;
        }
        if (target.className) {
            const classes = Array.from(target.classList).filter(c => !c.startsWith('razer-'));
            if (classes.length > 0) {
                tagString += `.${classes.join('.')}`;
            }
        }
        tagString += ` | ${Math.round(rect.width)} × ${Math.round(rect.height)}`;

        // Send coordinates and tags to the parent shell HTML
        window.parent.postMessage({
            type: 'hoverElement',
            rect: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height
            },
            tag: tagString
        }, '*');
    });

    document.addEventListener('mouseout', e => {
        if (!inspectModeActive) return;
        window.parent.postMessage({ type: 'hideHighlight' }, '*');
    });

    // Capture click and extract detailed metrics to send to inspect popup
    document.addEventListener('click', e => {
        if (!inspectModeActive) return;

        e.preventDefault();
        e.stopPropagation();

        const target = e.target;
        inspectModeActive = false;
        toggleInspectCursor(false);
        window.parent.postMessage({ type: 'hideHighlight' }, '*');

        const line = target.getAttribute('data-vscode-line');
        const col = target.getAttribute('data-vscode-col');

        if (!line) {
            console.warn("Clicked element has no VS Code line reference.");
            return;
        }

        // 1. Extract Text Content
        const text = target.innerText || target.textContent || '';

        // 2. Extract Attributes
        const attrs = [];
        Array.from(target.attributes).forEach(attr => {
            if (attr.name !== 'data-vscode-line' && attr.name !== 'data-vscode-col') {
                attrs.push({ name: attr.name, value: attr.value });
            }
        });

        // 3. Extract Styles (Key computed declarations)
        const computed = window.getComputedStyle(target);
        const styles = [];
        stylesToTrack.forEach(prop => {
            const val = computed.getPropertyValue(prop);
            if (val && val !== 'none' && val !== 'rgba(0, 0, 0, 0)' && val !== 'auto' && val !== 'normal') {
                styles.push({ name: prop, value: val });
            } else if (prop === 'display' || prop === 'position') {
                styles.push({ name: prop, value: val });
            }
        });

        // Send details to parent shell
        window.parent.postMessage({
            type: 'selectElement',
            line: line,
            col: col,
            tag: target.tagName,
            text: text,
            attrs: attrs,
            styles: styles
        }, '*');
    }, true); // Capture phase to prevent website navigation

    // Listen for events from parent window shell
    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || !message.type) return;

        if (message.type === 'setInspectMode') {
            inspectModeActive = message.active;
            toggleInspectCursor(inspectModeActive);
        } else if (message.type === 'applyPreviewEdit') {
            // Locate element inside iframe DOM
            const line = message.line;
            const col = message.col;
            const el = document.querySelector(`[data-vscode-line="${line}"][data-vscode-col="${col}"]`);
            
            if (el) {
                if (message.fieldType === 'text') {
                    el.innerText = message.value;
                } else if (message.fieldType === 'attribute') {
                    if (message.value === '' || message.value === null) {
                        el.removeAttribute(message.name);
                    } else {
                        el.setAttribute(message.name, message.value);
                    }
                } else if (message.fieldType === 'style') {
                    el.style[message.name] = message.value;
                }
            }
        }
    });

    console.log("Rage preview core helper loaded in iframe.");
})();

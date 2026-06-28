
// API Proxy helper - routes external API calls through local proxy to bypass CORS
// Works in both Chrome (direct) and Electron (via localhost proxy)
function getApiUrl(service, path) {
    const isLocalhost = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
    if (isLocalhost) {
        return `/api/proxy/${service}/${path}`;
    }
    const baseUrls = {
        'tmdb': 'https://api.themoviedb.org',
        'opensymbols': 'https://www.opensymbols.org/api/v1',
        'freesound': 'https://api.freesound.org',
        'freesound-proxy': 'https://aged-thunder-a674.narbehousellc.workers.dev'
    };
    return `${baseUrls[service]}/${path}`;
}

// Toast notification function (replaces alert to avoid focus issues)
function showToast(message, type = 'success') {
    let toast = document.getElementById('toast-notification');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-notification';
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 25px;
            border-radius: 8px;
            font-weight: 600;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            transition: opacity 0.3s, transform 0.3s;
            transform: translateY(-10px);
            opacity: 0;
            max-width: 400px;
        `;
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.background = type === 'error' ? '#dc3545' : type === 'warning' ? '#ffc107' : '#28a745';
    toast.style.color = type === 'warning' ? '#000' : '#fff';
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
    }, type === 'error' ? 4000 : 2500);
}

// Non-blocking confirm dialog (replaces confirm() to avoid focus issues)
function showConfirm(message) {
    return new Promise((resolve) => {
        let overlay = document.getElementById('confirm-dialog-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'confirm-dialog-overlay';
            overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;`;
            overlay.innerHTML = `
                <div style="background:#1e1e1e;border:1px solid #444;border-radius:12px;padding:25px;max-width:450px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
                    <p id="confirm-dialog-message" style="color:#fff;font-size:16px;margin:0 0 20px 0;white-space:pre-wrap;line-height:1.5;"></p>
                    <div style="display:flex;gap:12px;justify-content:flex-end;">
                        <button id="confirm-dialog-cancel" style="padding:10px 20px;border:1px solid #666;background:#333;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">Cancel</button>
                        <button id="confirm-dialog-ok" style="padding:10px 20px;border:none;background:#0d6efd;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">OK</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
        }
        document.getElementById('confirm-dialog-message').textContent = message;
        overlay.style.display = 'flex';
        const cleanup = (result) => { overlay.style.display = 'none'; resolve(result); };
        document.getElementById('confirm-dialog-ok').onclick = () => cleanup(true);
        document.getElementById('confirm-dialog-cancel').onclick = () => cleanup(false);
        overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    });
}
    toast.style.background = type === 'error' ? '#dc3545' : type === 'warning' ? '#ffc107' : '#28a745';
    toast.style.color = type === 'warning' ? '#000' : '#fff';
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
    }, type === 'error' ? 4000 : 2500);
}

class JumbleEditor {
    constructor() {
        this.words = [];
        this.filteredWords = [];
        this.currentIndex = -1; // Primary active index (edit target)
        this.selectedIndices = new Set(); // Multi-selection set
        
        // File Management
        this.currentFileName = "default";
        this.availableFiles = ["default"];

        // Bind UI
        this.wordInput = document.getElementById('word-input');
        this.sentenceInput = document.getElementById('sentence-input');
        this.imageInput = document.getElementById('image-input');
        this.previewImg = document.getElementById('image-preview');
        this.filterInput = document.getElementById('filter-input');
        this.listContainer = document.getElementById('word-list');
        this.countDisplay = document.getElementById('count-display');
        this.fileNameInput = document.getElementById('filename-input');
        this.sortSelect = document.getElementById('sort-select');
        
        // Enter key for symbol search
        document.getElementById('symbol-search-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.performSearch();
        });

        this.init();
    }

    async init() {
        // Load default server words.json
        this.fileNameInput.value = "words";
        this.currentFileName = "words";
        
        try {
            const res = await fetch('words.json');
            if (res.ok) {
                this.words = await res.json();
            } else {
                throw new Error("Failed to load words.json");
            }
            
            // Check if local storage overrides exist? 
            // In the simplified model, we just load default. 
            // If user wants local, they can "Load" or we could auto-load last session.
            // For now, prompt implies clean separation: "words.json ... loaded ... show words"
            
            this.cleanData();
            this.filterList();
        } catch(e) { 
            console.error("Init error", e);
            this.words = [];
        }
        
        this.createNew(); // Reset editor inputs
    }
    
    // Removed refreshFileList and loadSelectedFile as dropdown is gone

    cleanData() {
        // Remove duplicates based on 'word' property
        const unique = new Map();
        this.words.forEach(item => {
            if (item.word) {
                // Normalize word
                const w = item.word.trim().toLowerCase();
                if (!unique.has(w)) {
                    // Start clean object, stripping 'mode' if present implicitly by reconstruction
                    unique.set(w, {
                        word: w,
                        sentence: item.sentence || "",
                        image: item.image || ""
                    });
                } else {
                    // Update existing if new one has image or better sentence?
                    const existing = unique.get(w);
                    if (!existing.image && item.image) existing.image = item.image;
                }
            }
        });
        
        this.words = Array.from(unique.values());
        this.performSort();
    }
    
    sortList() {
        this.performSort();
        this.filterList();
    }
    
    performSort() {
        const mode = this.sortSelect ? this.sortSelect.value : 'alpha';
        
        this.words.sort((a, b) => {
            if (mode === 'alpha') return a.word.localeCompare(b.word);
            if (mode === 'alpha_rev') return b.word.localeCompare(a.word);
            if (mode === 'length_asc') {
                if (a.word.length !== b.word.length) return a.word.length - b.word.length;
                return a.word.localeCompare(b.word);
            }
            if (mode === 'length_desc') {
                 if (a.word.length !== b.word.length) return b.word.length - a.word.length;
                 return a.word.localeCompare(b.word);
            }
            return 0;
        });
    }

    filterList() {
        const query = this.filterInput.value.toLowerCase();
        this.filteredWords = this.words.filter(w => w.word.toLowerCase().includes(query));
        this.renderList();
    }

    renderList() {
        this.listContainer.innerHTML = '';
        this.filteredWords.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'word-item';
            
            // Find actual index in main array
            const realIndex = this.words.indexOf(item);
            const isSelected = this.selectedIndices.has(realIndex);
            
            if (isSelected) div.classList.add('active');
            
            const checkbox = `<input type="checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); editor.toggleSelection(${realIndex})" style="margin-right: 10px; transform: scale(1.2);">`;

            div.innerHTML = `
                <div style="display:flex; align-items:center; width: 100%;">
                    ${checkbox}
                    <div style="flex-grow: 1;">
                        <strong>${item.word}</strong> <span style="color:#888">(${item.word.length})</span>
                        <div style="font-size:12px; color:#666; margin-top:2px;">${item.sentence.substring(0, 30)}${item.sentence.length > 30 ? '...' : ''}</div>
                    </div>
                    ${item.image ? '<span style="font-size:12px">🖼️</span>' : ''}
                </div>
            `;
            
            div.onclick = (e) => this.selectWord(realIndex, e);
            
            this.listContainer.appendChild(div);
        });
        
        this.countDisplay.innerText = `${this.filteredWords.length} words`;
    }

    toggleSelection(index) {
        if (this.selectedIndices.has(index)) {
            this.selectedIndices.delete(index);
        } else {
            this.selectedIndices.add(index);
            // If selecting via checkbox, also load it into editor so user sees what they picked
            this.loadToEditor(index);
        }
        this.renderList();
    }
    
    loadToEditor(index) {
        this.currentIndex = index;
        const item = this.words[index];
        if (item) {
            this.wordInput.value = item.word || "";
            this.sentenceInput.value = item.sentence || "";
            this.imageInput.value = item.image || "";
            this.renderImagePreview();
        }
    }

    selectWord(index, event) {
        if (!event) {
            // Direct select (programmatic)
            this.selectedIndices.clear();
            this.selectedIndices.add(index);
        } else if (event.ctrlKey || event.metaKey) {
            // Toggle
            if (this.selectedIndices.has(index)) this.selectedIndices.delete(index);
            else this.selectedIndices.add(index);
        } else if (event.shiftKey && this.currentIndex !== -1) {
            // Range
            const start = Math.min(this.currentIndex, index);
            const end = Math.max(this.currentIndex, index);
            this.selectedIndices.clear();
            for (let i = start; i <= end; i++) {
                // Must verify i is visible if filtering? 
                // For simplicity, range in filtered view vs all words view is complex.
                // Let's do range on filteredWords, map to real indices.
                // This is simpler:
                // Find visible indices
                const visibleIndices = this.filteredWords.map(w => this.words.indexOf(w));
                const rangeStart = visibleIndices.indexOf(this.currentIndex);
                const rangeEnd = visibleIndices.indexOf(index);
                
                if (rangeStart !== -1 && rangeEnd !== -1) {
                     const s = Math.min(rangeStart, rangeEnd);
                     const e = Math.max(rangeStart, rangeEnd);
                     for(let k=s; k<=e; k++) {
                         this.selectedIndices.add(visibleIndices[k]);
                     }
                }
            }
        } else {
            // Single select (Row Click)
            // If clicking row, usually select exclusively
            this.selectedIndices.clear();
            this.selectedIndices.add(index);
        }
        
        // If we just selected one item or the last clicked item, that becomes current for editing
        if (this.selectedIndices.has(index) || (event && !event.shiftKey && !event.ctrlKey)) {
             this.loadToEditor(index);
        } else if (this.selectedIndices.size === 0) {
             this.clearEditor();
        }
        
        this.renderList();
    }
    
    highlightSelection() {
        this.renderList();
    }

    clearEditor() {
        this.currentIndex = -1;
        // Don't clear selections here? Or do we? 
        // "New Word" button calls this. 
        // "New Word" implies "I want to type a new word", so deselecting list items makes sense.
        this.selectedIndices.clear();
        
        this.wordInput.value = "";
        this.sentenceInput.value = "";
        this.imageInput.value = "";
        this.previewImg.style.display = 'none';
        this.renderList();
        this.wordInput.focus();
    }

    async createNewList() {
        if (this.words.length > 0) {
            if (!await showConfirm("Start a new list? Unsaved changes to the current list will be lost unless you saved them.")) return;
        }
        this.words = [];
        this.currentFileName = "untitled";
        this.fileNameInput.value = "";
        this.cleanData(); // resets sort/filter
        this.filterList();
        this.clearEditor();
        this.showStatus("Started new empty list");
    }

    createNew() { 
        this.clearEditor(); 
    }

    updatePreview() {
        // Optional: validate word or show length
    }

    renderImagePreview() {
        const url = this.imageInput.value;
        if (url) {
            this.previewImg.src = url;
            this.previewImg.style.display = 'block';
            this.previewImg.onerror = () => { this.previewImg.style.display = 'none'; };
        } else {
            this.previewImg.style.display = 'none';
        }
    }

    async applyChanges() {
        const word = this.wordInput.value.trim().toLowerCase();
        const sentence = this.sentenceInput.value.trim();
        const image = this.imageInput.value.trim();
        
        if (!word) { showToast("Word is required", "warning"); return; }
        if (!sentence) { showToast("Sentence is required", "warning"); return; }

        const newItem = { word, sentence, image };
        
        // Handle logic for update vs new
        if (this.currentIndex >= 0) {
            const originalWord = this.words[this.currentIndex].word;
            if (originalWord !== word) {
                if (this.words.some(w => w.word === word)) {
                    if (!await showConfirm("This word already exists. Overwrite?")) return;
                     // Remove the other instance to avoid duplicates
                     this.words = this.words.filter(w => w.word !== word);
                     // If we removed something, indices shift, but we are about to re-sort/re-find
                }
            }
            this.words[this.currentIndex] = newItem;
        } else {
            // New Item
             if (this.words.some(w => w.word === word)) {
                showToast("Word already exists!", "warning");
                return;
            }
            this.words.push(newItem);
        }
        
        // Sort
        this.performSort();
        
        // Find new location and select it
        const newIndex = this.words.indexOf(newItem);
        this.selectWord(newIndex);
        
        this.filterList();
        this.showStatus("Applied. Unsaved changes.");
    }

    async deleteSelected() {
        if (this.selectedIndices.size === 0) return;
        if (!await showConfirm(`Are you sure you want to delete ${this.selectedIndices.size} word(s)?`)) return;
        
        const indices = Array.from(this.selectedIndices).sort((a,b) => b-a);
        indices.forEach(idx => {
            if (idx >= 0 && idx < this.words.length) {
                this.words.splice(idx, 1);
            }
        });
        
        this.clearEditor();
        this.filterList();
        this.showStatus("Words deleted.");
    }

    deleteCurrent() {
        this.deleteSelected();
    }

    async saveToFile() {
        try {
            const btn = document.querySelector('.btn-success');
            // If button doesn't exist (if I changed HTML class?)
            // Just protecting
            const originalText = btn ? btn.innerText : "Save Server";
            if (btn) {
                btn.innerText = "Saving...";
                btn.disabled = true;
            }

            const res = await fetch('/api/save_words', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.words)
            });
            
            if (res.ok) {
                this.showStatus("File Saved Successfully!");
            } else {
                // If API is missing/mock, this fails silently usually or throws
                console.warn("Server save might not be implemented.");
                this.showStatus("Server save failed (is API running?)");
            }
            
            if (btn) {
                btn.innerText = originalText;
                btn.disabled = false;
            }
        } catch (e) {
            console.error(e);
            this.showStatus("Error saving to server.");
            const btn = document.querySelector('.btn-success');
            if (btn) btn.disabled = false;
        }
    }

    saveToLocalStorage() {
        let name = this.fileNameInput.value.trim();
        if (!name) name = "my_words"; // default if empty
        
        const key = 'wordjumble_list_' + name;
        
        try {
            localStorage.setItem(key, JSON.stringify(this.words));
            // Also store to default key so game picks it up immediately as 'Local' source
            localStorage.setItem('wordjumble_custom_words', JSON.stringify(this.words));
            localStorage.setItem('wordjumble_custom_name', name);
            
            this.showStatus(`Saved '${name}' to browser & set active!`);
        } catch (e) {
            showToast("Failed to save: " + e.message, "error");
        }
    }

    async downloadJSON() {
        let name = this.fileNameInput.value.trim().replace(/[^a-zA-Z0-9_\-\s]/g, ''); // Sanitize
        if (!name) name = "words";
        if (!name.toLowerCase().endsWith('.json')) name += ".json";

        const content = JSON.stringify(this.words, null, 2);
        
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: name,
                    types: [{
                        description: 'JSON File',
                        accept: {'application/json': ['.json']},
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(content);
                await writable.close();
                this.showStatus("File Saved");
                return;
            } catch (err) {
                if (err.name !== 'AbortError') console.error(err);
                if (err.name === 'AbortError') return; 
            }
        }
        
        // Fallback
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(content);
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", name);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    }

    showStatus(msg) {
        const el = document.getElementById('status-bar');
        el.innerText = msg;
        el.style.display = 'block';
        setTimeout(() => el.style.display = 'none', 3000);
    }

    uploadJSON(input) {
        const file = input.files[0];
        if (!file) return;
        
        // Update filename input with the uploaded file name (minus extension)
        const name = file.name.replace(/\.json$/i, '');
        this.fileNameInput.value = name;
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (Array.isArray(data)) {
                    if (await showConfirm("This will replace your current list. Continue?")) {
                        this.words = data;
                        this.cleanData();
                        this.filterList();
                        this.showStatus("Loaded file: " + file.name);
                    }
                } else {
                    showToast("Invalid file format", "error");
                }
            } catch (err) {
                showToast("Error reading file: " + err.message, "error");
            }
        };
        reader.readAsText(file);
        input.value = ''; // Reset
    }

    // --- Open Symbols Handling ---
    openSymbolSearch() {
        document.getElementById('search-modal').style.display = 'flex';
        document.getElementById('symbol-search-input').focus();
    }

    async performSearch() {
        const query = document.getElementById('symbol-search-input').value;
        if (!query) return;
        
        const container = document.getElementById('search-results');
        container.innerHTML = "Loading...";
        
        try {
            // Using Open Symbols API via proxy
            const res = await fetch(getApiUrl('opensymbols', `symbols/search?q=${encodeURIComponent(query)}`));
            const data = await res.json();
            
            container.innerHTML = "";
            if (!data || data.length === 0) {
                container.innerHTML = "No results found.";
                return;
            }
            
            data.forEach(item => {
                const div = document.createElement('div');
                div.className = 'symbol-item';
                div.innerHTML = `
                    <img src="${item.image_url}" loading="lazy">
                    <div style="font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.name}</div>
                `;
                div.onclick = () => {
                    this.imageInput.value = item.image_url;
                    this.renderImagePreview();
                    document.getElementById('search-modal').style.display = 'none';
                };
                container.appendChild(div);
            });
            
        } catch (e) {
            console.error(e);
            container.innerHTML = "Error fetching symbols.";
        }
    }
}

const editor = new JumbleEditor();

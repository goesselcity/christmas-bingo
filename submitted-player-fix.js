/* Goessel Bingo submitted-player UI fix, release 2026-11-17.1.
   Load AFTER app.js. Does not change the database schema or delete any data. */
(() => {
    'use strict';
    if (window.__bingoSubmittedFix) return;
    window.__bingoSubmittedFix = true;
    const byId = id => document.getElementById(id);
    const originalRender = render;
    const originalSubmit = submit;
    const originalActivate = activate;
    const originalPrint = printCard;
    function isSubmitted() { return !!(card && (card.submitted || card.receipt)); }
    function makeNote(id, text, anchor) {
        let node = byId(id);
        if (!node && anchor) {
            node = document.createElement('p'); node.id = id;
            node.className = 'small hint'; node.textContent = text;
            anchor.insertAdjacentElement('afterend', node);
        }
        return node;
    }
    function ensureElements() {
        const save = byId('save');
        const row = save && save.parentElement;
        makeNote('saveNote', 'Download Card Picture saves a picture of your submitted card with no name or contact info.', row);
        makeNote('autosaveNote', 'Your progress saves automatically on this device. Come back anytime before the deadline.', row);
        if (!byId('received') && byId('message')) {
            const panel = document.createElement('div'); panel.id = 'received';
            panel.className = 'received'; panel.hidden = true;
            byId('message').insertAdjacentElement('beforebegin', panel);
        }
        if (!byId('submittedUiStyle')) {
            const style = document.createElement('style'); style.id = 'submittedUiStyle';
            style.textContent = '[hidden]{display:none!important}.received{background:#e8f4ec;border:3px solid #145a3c;border-radius:14px;padding:12px 14px;margin-bottom:10px;color:#0d3d29}.received strong{display:block;font:700 24px Georgia,serif}.bingo-ui-version{font-size:11px;opacity:.8;margin-top:8px}';
            document.head.append(style);
        }
    }
    function updateNameFromCard() {
        if (!card || !card.submittedName) return false;
        const p = players.find(p => p.token === token);
        if (!p || p.label === card.submittedName) return false;
        p.label = card.submittedName; return true;
    }
    function enforceControls() {
        const done = isSubmitted();
        if (card && done) card.submitted = true;
        const save = byId('save'), print = byId('print');
        if (save) {
            save.hidden = !done; save.textContent = 'Download Card Picture';
            save.disabled = busy || !done;
        }
        if (print) { print.hidden = done; print.disabled = busy || !card || done; }
        if (byId('saveNote')) byId('saveNote').hidden = !done;
        if (byId('autosaveNote')) byId('autosaveNote').hidden = done;
        const received = byId('received');
        if (received) {
            received.hidden = !done;
            if (done) {
                const title = document.createElement('strong'); title.textContent = '🎉 Entry received!';
                const body = document.createElement('div');
                body.textContent = 'Your Bingo has been submitted. The current organizer status is shown below.';
                received.replaceChildren(title, body);
            }
        }
        // Hide only the print-button help paragraph, not the actual printable card.
        const host = byId('message') && byId('message').closest('section');
        if (host) {
            for (const p of host.querySelectorAll('p.small.hint')) {
                const bold = p.querySelector('b');
                if (bold && bold.textContent.trim() === 'Print Card') p.hidden = done;
            }
        }
        if (!byId('submittedUiVersion') && byId('offlineReady')) {
            const version = document.createElement('div'); version.id = 'submittedUiVersion';
            version.className = 'bingo-ui-version'; version.textContent = 'Card controls update: 2026-11-17.1';
            byId('offlineReady').insertAdjacentElement('afterend', version);
        }
    }
    render = function () {
        ensureElements();
        if (isSubmitted()) card.submitted = true;
        updateNameFromCard();
        originalRender();
        enforceControls();
    };
    activate = async function (t) {
        await originalActivate(t);
        if (card && card.submittedName) { updateNameFromCard(); await savePlayers(); render(); }
    };
    async function submitAndLabel(e) {
        if (busy || !card) { e.preventDefault(); return; }
        const activeToken = token;
        const input = byId('entryForm').elements.name;
        const enteredName = input.value.replace(/[\x00-\x1f]/g, '').trim().slice(0, 100);
        // Capture before the existing success handler resets the form.
        await originalSubmit(e);
        if (card && token === activeToken && isSubmitted() && enteredName) {
            card.submittedName = enteredName;
            updateNameFromCard();
            try { await saveCard(); await savePlayers(); }
            catch (err) { message('Your entry was received, but the player name could not be saved on this device. Use Rename to correct it.', true); }
        }
        render();
    }
    renamePlayer = function () {
        if (busy || !card) return;
        const player = players.find(p => p.token === token);
        if (!player) return;
        const entered = prompt('Name for this card:', /^Player \d+$/.test(player.label) ? '' : player.label);
        if (entered === null) return;
        const name = entered.replace(/[\x00-\x1f]/g, '').trim().slice(0, 100);
        if (!name) return;
        player.label = name;
        if (isSubmitted()) card.submittedName = name;
        Promise.all([saveCard(), savePlayers()]).then(render).catch(err => message(err.message, true));
    };
    byId('renamePlayer').onclick = renamePlayer;
    submit = submitAndLabel;
    byId('entryForm').onsubmit = submitAndLabel;
    printCard = function () { if (!isSubmitted()) originalPrint(); };
    byId('print').onclick = printCard;
    ensureElements();
    // The original start() is asynchronous; render will also run when loading finishes.
    if (typeof players !== 'undefined') render();
})();

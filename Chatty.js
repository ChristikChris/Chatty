// ==UserScript==
// @name         Paragon Chat Timing Reminder
// @namespace    https://tampermonkey.net/paragon-chat-reminder
// @version      1.5.3
// @description  Reminds associates to update customers during chat cases in Paragon (5-minute cadence) + Patience quick-fill
// @author       christik@ with a lot of help from Kiro
// @match        https://paragon-eu.amazon.com/*
// @match        https://paragon-na.amazon.com/*
// @match        https://paragon-fe.amazon.com/*
// @match        https://paragon-cn.amazon.com/*
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ---------------- Config ----------------
    // Production cadence: gentle reminder at 5 min, escalation at 7 min.
    const REMIND_AT_MS  = 5 * 60 * 1000; // 5 min – ask customer for more time
    const TIMEOUT_AT_MS = 7 * 60 * 1000; // 7 min – urgent reminder
    const TICK_MS       = 1000;
    const POSITION_MS   = 250;       // re-position box below input

    // ---------------- Patience phrases (cycled per language) ----------------
    const PATIENCE_PHRASES = {
        EN: [
            "Thanks for your patience. I'm still looking into your case and need a few more minutes.",
            "I'm still researching this for you. Please bear with me a moment longer.",
            "I appreciate your patience while I check the details. I'll be back with you shortly.",
            "Just need a little more time to review everything carefully. Thank you for waiting.",
            "I'm still working on this for you. I'll have an update in a few minutes."
        ],
        ES: [
            "Gracias por su paciencia. Sigo revisando su caso y necesito unos minutos más.",
            "Continúo investigando su consulta. Le agradezco que espere un momento más.",
            "Agradezco su paciencia mientras verifico los detalles. Volveré con usted en breve.",
            "Necesito un poco más de tiempo para revisar todo con cuidado. Muchas gracias por esperar.",
            "Sigo trabajando en su caso. Le daré una actualización en unos minutos."
        ],
        DE: [
            "Vielen Dank für Ihre Geduld. Ich prüfe Ihren Fall noch und benötige einige Minuten mehr.",
            "Ich recherchiere noch für Sie. Bitte haben Sie noch einen kurzen Moment Geduld.",
            "Ich danke Ihnen für Ihre Geduld, während ich die Details prüfe. Ich melde mich gleich wieder.",
            "Ich brauche noch etwas Zeit, um alles sorgfältig zu prüfen. Vielen Dank fürs Warten.",
            "Ich arbeite weiterhin an Ihrem Anliegen und gebe Ihnen in wenigen Minuten ein Update."
        ]
    };
    const patienceIdx = { EN: 0, ES: 0, DE: 0 };

    const isTop = window.top === window.self;

    // ---------------- UI (top window only) ----------------
    let box, timeEl, labelEl, msgEl;

    function buildUI() {
        if (!isTop || document.getElementById('pcr-box')) return;

        const style = document.createElement('style');
        style.textContent = `
            #pcr-box{
                position:fixed; left:12px; top:12px; z-index:2147483647;
                background:#2d3e50; color:#fff; padding:8px 12px;
                border-radius:8px;
                font:600 13px/1.3 "Amazon Ember","Segoe UI",Arial,sans-serif;
                box-shadow:0 4px 14px rgba(0,0,0,.25); user-select:none;
                display:none; max-width:420px;
                transition:background-color .25s ease;
            }
            #pcr-box .row{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
            #pcr-time{
                font-variant-numeric:tabular-nums; font-size:15px;
                min-width:48px; text-align:center;
            }
            #pcr-box button{
                background:rgba(255,255,255,.18); color:#fff;
                border:0; border-radius:4px;
                padding:2px 7px; cursor:pointer; font-weight:700; font-size:12px;
                transition:background-color .15s ease;
            }
            #pcr-box button:hover{ background:rgba(255,255,255,.30); }
            #pcr-box .pcr-lang{
                background:#3a7d6e !important;     /* calm teal */
                padding:3px 8px !important;
                min-width:36px;
            }
            #pcr-box .pcr-lang:hover{ background:#4a9384 !important; }
            #pcr-msg{
                display:none; margin-top:6px;
                font-weight:400; font-size:12px; line-height:1.35;
            }
            #pcr-box.warn  { background:#a16207 }   /* calm amber */
            #pcr-box.alert { background:#7c4f5d }   /* dusty rose */
            #pcr-box.warn  #pcr-msg,
            #pcr-box.alert #pcr-msg { display:block }
        `;
        document.documentElement.appendChild(style);

        box = document.createElement('div');
        box.id = 'pcr-box';
        box.innerHTML = `
            <div class="row">
                <span id="pcr-label">⏱ Since last reply</span>
                <span id="pcr-time">--:--</span>
                <button type="button" class="pcr-lang" data-lang="EN" title="Insert English patience phrase (cycles 5)">🇬🇧 EN</button>
                <button type="button" class="pcr-lang" data-lang="ES" title="Insertar frase de paciencia en español (cicla 5)">🇪🇸 ES</button>
                <button type="button" class="pcr-lang" data-lang="DE" title="Geduldssatz auf Deutsch einfügen (5 im Wechsel)">🇩🇪 DE</button>
                <button type="button" id="pcr-reset" title="Reset timer">↻</button>
                <button type="button" id="pcr-hide"  title="Hide until next reply">×</button>
            </div>
            <div id="pcr-msg"></div>
        `;
        document.documentElement.appendChild(box);

        timeEl  = box.querySelector('#pcr-time');
        labelEl = box.querySelector('#pcr-label');
        msgEl   = box.querySelector('#pcr-msg');
        box.querySelector('#pcr-reset').addEventListener('click', () => resetTimer('manual'));
        box.querySelector('#pcr-hide').addEventListener('click', () => { box.style.display = 'none'; });
        box.querySelectorAll('.pcr-lang').forEach((btn) => {
            btn.addEventListener('click', (e) => insertPatience(e, btn.dataset.lang));
        });
    }

    // ---------------- Box positioning (top-right of the chat panel) ----------------
    function findChatPanel(ta) {
        // Walk up from the textarea looking for a sensibly-sized container
        // that represents the whole chat panel (header + transcript + input).
        let el = ta;
        let best = null;
        for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
            const r = el.getBoundingClientRect();
            if (r.width >= 260 && r.height >= 280) { best = el; }
        }
        return best;
    }

    function positionBox() {
        if (!box) return;
        const ta = findTextarea();
        // Hide entirely if there is no chat input on this page (e.g. full case view)
        if (!ta || startedAt === null) {
            box.style.display = 'none';
            return;
        }

        const panel = findChatPanel(ta);
        const inputContainer =
            ta.closest('form') ||
            ta.closest('[class*="input" i]') ||
            ta.closest('[class*="composer" i]') ||
            ta.parentElement;
        const panelRect = (panel || inputContainer || ta).getBoundingClientRect();

        if (panelRect.width === 0 || panelRect.height === 0) {
            box.style.display = 'none';
            return;
        }

        // Make the box visible first so we can measure its real height
        box.style.display = 'block';
        box.style.visibility = 'hidden';

        const margin = 8;
        // Box should fit comfortably inside the chat panel width
        const boxWidth = Math.min(Math.max(panelRect.width - margin * 2, 240), 420);
        box.style.width = boxWidth + 'px';

        const boxH = box.offsetHeight || 40;

        // Anchor to the TOP-RIGHT of the chat panel (the area circled in yellow).
        // Stays out of the message transcript and out of the chat input.
        let top  = panelRect.top + margin;
        let left = panelRect.right - boxWidth - margin;

        // Clamp to viewport so the box never escapes the screen
        if (top + boxH + margin > window.innerHeight) {
            top = Math.max(margin, window.innerHeight - boxH - margin);
        }
        if (top < margin) top = margin;
        if (left < margin) left = margin;
        if (left + boxWidth + margin > window.innerWidth) {
            left = Math.max(margin, window.innerWidth - boxWidth - margin);
        }

        box.style.left   = left + 'px';
        box.style.right  = 'auto';
        box.style.top    = top + 'px';
        box.style.bottom = 'auto';
        box.style.visibility = 'visible';
    }

    // ---------------- Patience button: fill textarea (React-friendly) ----------------
    // We only set the value + fire 'input' so React/the chat widget picks it up.
    // We deliberately do NOT dispatch 'change', press Enter, or click the send
    // button — the message stays in the field as an editable draft.
    function setReactValue(el, value) {
        const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function insertPatience(e, lang) {
        // Stop the click from bubbling into any surrounding chat form handlers
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const ta = findTextarea();
        if (!ta) return;
        const list = PATIENCE_PHRASES[lang] || PATIENCE_PHRASES.EN;
        const phrase = list[patienceIdx[lang] % list.length];
        patienceIdx[lang] = (patienceIdx[lang] + 1) % list.length;
        setReactValue(ta, phrase);
        ta.focus();
        // Place caret at end so the associate can keep editing immediately
        try { ta.setSelectionRange(phrase.length, phrase.length); } catch (_) {}
    }

    // ---------------- Sound (WebAudio, soft chimes with envelope) ----------------
    let audioCtx = null;
    function tone(freq, durMs, vol) {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const now = audioCtx.currentTime;
            const dur = durMs / 1000;
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.type = 'sine';
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, now);
            g.gain.exponentialRampToValueAtTime(vol, now + 0.03);
            g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
            o.connect(g); g.connect(audioCtx.destination);
            o.start(now); o.stop(now + dur + 0.05);
        } catch (_) {}
    }
    function softChime() {
        tone(587.33, 260, 0.08); // D5
        setTimeout(() => tone(880.00, 360, 0.08), 180); // A5
    }
    function softAlert() {
        tone(659.25, 240, 0.10); // E5
        setTimeout(() => tone(523.25, 240, 0.10), 260); // C5
        setTimeout(() => tone(659.25, 460, 0.10), 520); // E5
    }

    // ---------------- Timer state (top window) ----------------
    let startedAt = null;
    let firedRemind = false;
    let firedTimeout = false;
    let missingSince = 0; // timestamp the textarea first went missing

    function fmt(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }

    function resetTimer(reason) {
        startedAt    = Date.now();
        firedRemind  = false;
        firedTimeout = false;
        if (box) {
            box.classList.remove('warn', 'alert');
            if (msgEl) msgEl.textContent = '';
        }
        if (labelEl) labelEl.textContent = '⏱ Since last reply';
        positionBox();
        console.log('[ChatReminder] reset:', reason);
    }

    function stopTimer(reason) {
        if (startedAt === null) return;
        startedAt    = null;
        firedRemind  = false;
        firedTimeout = false;
        if (box) {
            box.classList.remove('warn', 'alert');
            if (msgEl) msgEl.textContent = '';
            box.style.display = 'none';
        }
        console.log('[ChatReminder] stopped:', reason);
    }

    function tick() {
        if (!startedAt || !timeEl) return;

        // Stop firing reminders if the chat is no longer open
        // (textarea gone = chat closed/transferred/ended).
        // Use a short grace window so a brief SPA re-render doesn't kill the timer.
        if (!findTextarea()) {
            if (!missingSince) missingSince = Date.now();
            if (Date.now() - missingSince > 4000) {
                stopTimer('chat-closed');
                missingSince = 0;
            }
            return;
        }
        missingSince = 0;

        const elapsed = Date.now() - startedAt;
        timeEl.textContent = fmt(elapsed);

        if (!firedRemind && elapsed >= REMIND_AT_MS) {
            firedRemind = true;
            box.classList.add('warn');
            msgEl.textContent = 'Let the customer know you are still researching and need more time.';
            softChime();
            try { GM_notification({ title: 'Chat reminder', text: 'Update the customer – still researching', timeout: 8000 }); } catch (_) {}
            positionBox(); // height changed
        }
        if (!firedTimeout && elapsed >= TIMEOUT_AT_MS) {
            firedTimeout = true;
            box.classList.remove('warn');
            box.classList.add('alert');
            msgEl.textContent = 'The window is up. Send an update to the customer now.';
            softAlert();
            try { GM_notification({ title: 'Chat reminder (urgent)', text: 'Reply window elapsed – please reply', timeout: 15000 }); } catch (_) {}
            positionBox();
        }
    }

    // ---------------- Cross-frame signalling ----------------
    const TAG = 'PCR_AGENT_REPLY_SENT';

    function notifyAgentReply() {
        if (isTop) resetTimer('agent-reply');
        else { try { window.top.postMessage({ __pcr: TAG }, '*'); } catch (_) {} }
    }

    if (isTop) {
        window.addEventListener('message', (e) => {
            if (e.data && e.data.__pcr === TAG) resetTimer('agent-reply');
        });
    }

    // ---------------- Detect agent sending a message ----------------
    const TEXTAREA_SELECTORS = [
        'textarea[placeholder*="Write a message" i]',
        'textarea[aria-label*="message" i]',
        'textarea[data-testid*="chat" i]'
    ];
    const SEND_BUTTON_SELECTORS = [
        'button[aria-label*="send" i]',
        'button[data-testid*="send" i]',
        'button[title*="send" i]'
    ];

    function findTextarea() {
        for (const sel of TEXTAREA_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }
    function findSendButton(ta) {
        const root = (ta && (ta.closest('form, section, div'))) || document;
        for (const sel of SEND_BUTTON_SELECTORS) {
            const el = root.querySelector(sel) || document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    const hooked = new WeakSet();

    function hookTextarea(ta) {
        if (!ta || hooked.has(ta)) return;
        hooked.add(ta);

        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && ta.value.trim().length > 0) {
                setTimeout(notifyAgentReply, 80);
            }
        }, true);

        const btn = findSendButton(ta);
        if (btn && !hooked.has(btn)) {
            hooked.add(btn);
            btn.addEventListener('click', () => {
                if (ta.value.trim().length > 0) setTimeout(notifyAgentReply, 80);
            }, true);
        }
        // Timer only starts after the associate sends their first reply.
    }

    if (isTop) {
        window.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
                e.preventDefault();
                if (startedAt !== null) resetTimer('hotkey');
            }
        });
    }

    const scanObserver = new MutationObserver(() => {
        const ta = findTextarea();
        if (ta) hookTextarea(ta);
    });
    scanObserver.observe(document.documentElement, { childList: true, subtree: true });

    const initialTA = findTextarea();
    if (initialTA) hookTextarea(initialTA);

    // ---------------- Boot ----------------
    if (isTop) {
        buildUI();
        setInterval(tick, TICK_MS);
        setInterval(positionBox, POSITION_MS);
        window.addEventListener('resize', positionBox);
        window.addEventListener('scroll', positionBox, true);
    }
})();

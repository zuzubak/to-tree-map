/* "Report a problem with this tree" -- a short form that lives inside the tree popup --
 * and "Add a missing tree", the same form opened at a spot on the map instead of a tree.
 *
 * Two screens: pick what's wrong (or, when adding, confirm the tree is the City's), then
 * give the details (plus an optional note and email) and send. Reports go to TREE_REPORT_URL, which forwards them for review by
 * hand; nothing a reader sends changes the map until it has been approved.
 *
 * Along with the fix, every report carries a snapshot of what the popup showed -- species,
 * trunk, address, position. That snapshot is what lets an approved correction be
 * reconciled against later City refreshes (see dbt/models/staging/int_tree_corrections.sql),
 * so it is sent exactly as displayed rather than re-derived on the server.
 *
 * map.js owns the data; this file only needs what it is handed in `ctx`.
 */
(function () {
  const ENDPOINT = () => window.TREE_REPORT_URL;
  const SENT_KEY = "tree-reports-sent";

  const KINDS = [
    { kind: "remove", label: "There's no tree here", hint: "Cut down, a stump, or never planted" },
    { kind: "species", label: "It's a different species" },
    { kind: "dbh", label: "The trunk size is wrong" },
    { kind: "address", label: "The address is wrong" },
    { kind: "other", label: "Something else" },
  ];

  // The City's inventory is the road allowance: everything between the curb and the
  // property line. A tree past the property line is private and the City doesn't track it.
  const BOULEVARD_HELP = "The City's part of the street runs from the curb to the property line, sidewalk included. Trees past the property line are private, and the City doesn't record them.";

  const REMOVE_REASONS = [
    ["stump", "It was cut down: there's a stump or an empty planting spot"],
    ["never", "I don't think there's ever been a tree here"],
    ["unsure", "Not sure, but there's no tree"],
  ];

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid) n.append(kid);
    return n;
  }

  function sentBefore(id) {
    try { return (JSON.parse(localStorage.getItem(SENT_KEY)) || {})[id] || null; }
    catch (e) { return null; }
  }
  function rememberSent(id) {
    try {
      const all = JSON.parse(localStorage.getItem(SENT_KEY)) || {};
      all[id] = new Date().toISOString().slice(0, 10);
      localStorage.setItem(SENT_KEY, JSON.stringify(all));
    } catch (e) { /* private window: fine */ }
  }

  /* The button that sits at the foot of the popup. `body` is the part of the popup the
   * form replaces; the title stays, so the reader keeps sight of which tree it is. */
  function button(ctx, popupBody, host) {
    if (!ENDPOINT()) return null;
    const caption = () => sentBefore(ctx.tree.key)
      ? "You reported this tree. Report another problem" : "Report a problem with this tree";
    const foot = h("div", { class: "report-foot" },
      h("button", {
        type: "button", class: "report-open",
        text: caption(),
        onclick: (e) => {
          const opener = e.currentTarget;
          popupBody.hidden = true;
          foot.hidden = true;
          const form = mount(ctx, () => {
            ctx.preview(null);
            form.remove();
            popupBody.hidden = false;
            foot.hidden = false;
            opener.textContent = caption();
            ctx.resize();
          });
          host.appendChild(form);
          ctx.resize();
        },
      }),
    );
    return foot;
  }

  /* The add form: `ctx.tree` is the spot the reader tapped, with the nearest tree's address
   * as a starting suggestion. */
  function addForm(ctx, close) {
    return mount(Object.assign({}, ctx, { mode: "add" }), close);
  }

  function mount(ctx, close) {
    const t = ctx.tree;
    const adding = ctx.mode === "add";
    const shown = ctx.shown || t; // what the reader was looking at
    const root = h("form", { class: "report", novalidate: true });
    // Leaflet listens for +/- and arrows on the document while the map has focus.
    root.addEventListener("keydown", (e) => e.stopPropagation());
    // Each step replaces the form's contents from inside a click handler. By the time the
    // click reaches the map the button is detached, so Leaflet can't walk up to the popup
    // to see it was inside one, and takes it for a click on the map -- closing the popup.
    root.addEventListener("click", (e) => e.stopPropagation());
    root.addEventListener("submit", (e) => e.preventDefault());
    // Warm the STRUCTID lookup while they type, so Send doesn't wait on it.
    const structId = adding ? Promise.resolve(null) : ctx.structId().catch(() => null);

    const draft = { kind: null };
    // Whatever the current step needs tidied before it is replaced (the Turnstile widget).
    let leaving = () => {};
    const finish = () => { leaving(); leaving = () => {}; close(); };

    function show(...kids) {
      leaving();
      leaving = () => {};
      root.replaceChildren(...kids);
      ctx.resize();
      const first = root.querySelector("input:not([type=hidden]):not([tabindex='-1']), textarea, button.report-choice");
      if (first && window.matchMedia("(pointer: fine)").matches) first.focus();
    }

    function step1() {
      ctx.preview(null);
      if (adding) return boulevard();
      show(
        h("div", { class: "report-q", text: "What's wrong with this record?" }),
        h("div", { class: "report-choices" },
          KINDS.map((k) => h("button", {
            type: "button", class: "report-choice",
            onclick: () => { draft.kind = k.kind; step2(); },
          }, h("span", { text: k.label }), k.hint ? h("small", { text: k.hint }) : null)),
        ),
        h("div", { class: "report-actions" },
          h("button", { type: "button", class: "report-btn", text: "Cancel", onclick: finish })),
      );
    }

    function boulevard() {
      show(
        h("div", { class: "report-q", text: "Is the tree between the curb and the property line?" }),
        h("div", { class: "report-help report-help-top", text: BOULEVARD_HELP }),
        h("div", { class: "report-choices" },
          h("button", { type: "button", class: "report-choice", onclick: addDetails },
            h("span", { text: "Yes, it's on the City's side" })),
          h("button", { type: "button", class: "report-choice", onclick: privateTree },
            h("span", { text: "No, it's on private property" })),
        ),
        h("div", { class: "report-actions" },
          h("button", { type: "button", class: "report-btn", text: "Cancel", onclick: finish })),
      );
    }

    function privateTree() {
      show(
        h("div", { class: "report-q", text: "Then it isn't one for this map." }),
        h("div", { class: "report-help report-help-top", text: "The map shows the City's own street trees, from its inventory. Private trees aren't in it, so there's nothing here to add. Thanks for looking, though." }),
        h("div", { class: "report-actions" },
          h("button", { type: "button", class: "report-btn", text: "Back", onclick: boulevard }),
          h("button", { type: "button", class: "report-btn report-primary", text: "Close", onclick: finish })),
      );
    }

    function addDetails() {
      const sp = fieldsFor("species");
      const dbh = fieldsFor("dbh");
      const adr = fieldsFor("address");
      sendStep({
        q: "Tell me about the tree",
        el: h("div", { class: "report-add" },
          h("div", { class: "report-sub", text: sp.q }), sp.el,
          h("div", { class: "report-sub", text: dbh.q }), dbh.el,
          h("div", { class: "report-sub", text: adr.q }), adr.el),
        read: () => {
          const parts = [sp.read(), dbh.read(), adr.read()];
          const bad = parts.find((p) => p.error);
          if (bad) return bad;
          const proposed = Object.assign({}, ...parts.map((p) => p.proposed), { lat: t.lat, lon: t.lon });
          // How many trees of this genus the City has at that address now, so a refresh
          // that adds this same tree can be recognised (see int_tree_corrections.sql).
          proposed.genus_counts = ctx.genusCounts(proposed.address, proposed.street);
          return { proposed, measured: parts[1].measured };
        },
        back: boulevard,
      });
    }

    /* Each kind contributes a fieldset and a read() returning {proposed, error}. */
    function fieldsFor(kind) {
      if (kind === "remove") {
        const radios = REMOVE_REASONS.map(([v, label], n) => h("label", { class: "report-radio" },
          h("input", { type: "radio", name: "reason", value: v, checked: n === 0 }), h("span", { text: label })));
        return {
          q: "What's there now?",
          el: h("div", { class: "report-choices" }, radios),
          read: () => ({ proposed: { reason: root.querySelector("input[name=reason]:checked").value } }),
        };
      }

      if (kind === "species") {
        const listId = "report-taxa";
        const options = ctx.taxa
          .filter((x) => x.genus && x.botanical !== shown.botanical)
          .sort((a, b) => b.count - a.count)
          .map((x) => h("option", { value: label(x) }));
        const input = h("input", {
          type: "text", class: "report-input", list: listId, autocomplete: "off",
          placeholder: "Start typing: red oak, Quercus…", "aria-label": "Species",
        });
        const unsure = h("input", { type: "checkbox" });
        return {
          q: "What species is it?",
          el: h("div", {},
            input, h("datalist", { id: listId }, options),
            h("label", { class: "report-check" }, unsure,
              h("span", { text: adding ? "I don't know what it is" : `I don't know, but it isn't ${article(shown.common || shown.botanical)}` })),
            h("div", { class: "report-help", text: adding
              ? "Only species already in the City's inventory are listed. Not there? Tick “I don't know” and describe it in the note."
              : "Only species already in the City's inventory are listed. Not there? Pick “Something else” instead." }),
          ),
          read: () => {
            if (unsure.checked) return { proposed: { botanical: null, unsure: true } };
            const v = input.value.trim().toLowerCase();
            const hit = ctx.taxa.find((x) => label(x).toLowerCase() === v
              || x.botanical.toLowerCase() === v || (x.common || "").toLowerCase() === v);
            if (!hit) return { error: "Pick a species from the list, or tick “I don't know”." };
            return { proposed: { botanical: hit.botanical, common: hit.common } };
          },
        };
      }

      if (kind === "dbh") {
        const value = h("input", {
          type: "number", class: "report-input report-num", min: "1", max: "1000", step: "any",
          inputmode: "decimal", "aria-label": "Measurement",
        });
        const unit = h("select", { class: "report-input report-unit", "aria-label": "Unit" },
          h("option", { value: "cm", text: "cm" }), h("option", { value: "in", text: "in" }));
        // Which measurement they took: around the trunk or straight across it.
        const mode = (v, label, on) => h("label", { class: "report-seg-opt" },
          h("input", { type: "radio", name: "dbh-mode", value: v, checked: on }), h("span", { text: label }));
        const toggle = h("div", { class: "report-seg", role: "radiogroup", "aria-label": "Measurement" },
          mode("around", "Circumference", true), mode("across", "Diameter", false));
        const isDiameter = () => toggle.querySelector("input:checked").value === "across";
        const readout = h("div", { class: "report-help", "aria-live": "polite" });

        const diameter = () => {
          const raw = parseFloat(value.value);
          if (!(raw > 0)) return null;
          const cm = raw * (unit.value === "in" ? 2.54 : 1);
          return Math.round(isDiameter() ? cm : cm / Math.PI);
        };
        const update = () => {
          const d = diameter();
          const said = d === null ? "" : isDiameter() ? `That's ${d} cm across.` : `That's about ${d} cm across.`;
          if (adding) {
            readout.textContent = d === null ? "Leave it empty if you can't measure it." : said;
            return;
          }
          readout.textContent = d === null
            ? (shown.dbh ? `The map has a ${shown.dbh} cm diameter, about ${Math.round(shown.dbh * Math.PI)} cm around.` : "The map has no trunk size for it.")
            : said.replace(/\.$/, "") + (shown.dbh ? `; the map has ${shown.dbh} cm.` : ".");
        };
        for (const n of [value, unit, toggle]) n.addEventListener("input", update);
        toggle.addEventListener("change", update);
        update();
        return {
          q: adding ? "How big is the trunk? (optional)" : "How big is the trunk?",
          el: h("div", {},
            toggle,
            h("div", { class: "report-row" }, value, unit),
            readout,
          ),
          read: () => {
            const d = diameter();
            if (d === null && adding) return { proposed: { dbh_cm: null } };
            if (d === null) return { error: "Enter the measurement." };
            if (d < 1 || d > 300) return { error: "That works out to " + d + " cm across, which can't be right. Check the unit?" };
            if (d === shown.dbh && !adding) return { error: "That matches what the map shows." };
            return {
              proposed: { dbh_cm: d },
              measured: { value: parseFloat(value.value), unit: unit.value, how: isDiameter() ? "across" : "around" },
            };
          },
        };
      }

      if (kind === "address") {
        const number = h("input", {
          type: "text", class: "report-input report-num", inputmode: "numeric",
          value: shown.address ? String(shown.address) : "", "aria-label": "Street number",
        });
        const listId = "report-streets";
        const street = h("input", {
          type: "text", class: "report-input", list: listId, autocomplete: "off",
          value: shown.street || "", "aria-label": "Street",
        });
        // Built on first focus: ten thousand <option>s is not free.
        street.addEventListener("focus", () => {
          if (root.querySelector("#" + listId)) return;
          street.after(h("datalist", { id: listId }, ctx.streets.filter(Boolean).map((s) => h("option", { value: s }))));
        }, { once: true });

        // The City places each tree at its address, so a new address means a new spot on
        // the map. Look it up as they type, and draw where the dot would go.
        const found = h("div", { class: "report-help", "aria-live": "polite",
          text: adding
            ? (ctx.addressFrom === "search" ? "The property the tree stands in front of, from your search. Change it if the tree is in front of a neighbour." : "The property the tree stands in front of. Filled in from the nearest tree on the map, so check it.")
            : "The address of the property the tree stands in front of." });
        let place = null;
        let seq = 0;
        let timer = null;
        const lookup = () => {
          clearTimeout(timer);
          place = null;
          ctx.preview(null);
          const n = parseInt(number.value, 10);
          const s = street.value.trim();
          if (!(n > 0) || s.length < 3 || (!adding && n === shown.address && s.toUpperCase() === shown.street)) return;
          timer = setTimeout(async () => {
            const mine = ++seq;
            found.textContent = "Looking it up…";
            try {
              const q = new URLSearchParams({
                address: n, street: s, lat: t.lat, lon: t.lon,
                from_address: shown.address || "", from_street: shown.street || "",
              });
              const r = await (await fetch(ENDPOINT().replace(/report$/, "place") + "?" + q)).json();
              if (mine !== seq) return;
              if (!r.found) {
                found.textContent = "That isn't in the City's address list. Check the number? You can still send it.";
                return;
              }
              place = r;
              if (adding) {
                // The new tree goes where it was tapped; the address only labels it.
                found.textContent = `Found ${r.label} in the City's address list.`;
                return;
              }
              ctx.preview(r);
              found.textContent = `Found ${r.label}. The dot moves about ${distance(t, r)} ${bearing(t, r)}.`;
              ctx.resize();
            } catch (e) {
              if (mine === seq) found.textContent = "Couldn't check the address just now. You can still send it.";
            }
          }, 450);
        };
        number.addEventListener("input", lookup);
        street.addEventListener("input", lookup);
        if (adding) lookup(); // check the suggested address straight away

        return {
          q: adding ? "What's the address?" : "What's the right address?",
          el: h("div", {}, h("div", { class: "report-row" }, number, street), found),
          read: () => {
            const n = parseInt(number.value, 10);
            const s = street.value.trim().toUpperCase().replace(/\s+/g, " ");
            if (!(n > 0) || !s) return { error: "Enter a street number and a street." };
            if (!adding && n === shown.address && s === shown.street) return { error: "That's the address the map already shows." };
            if (adding) return { proposed: { address: n, street: s, known_street: ctx.streets.includes(s), ward: place ? place.ward : null } };
            return { proposed: {
              address: n, street: s, known_street: ctx.streets.includes(s),
              lat: place ? place.lat : null, lon: place ? place.lon : null,
            } };
          },
        };
      }

      return { q: "What's wrong?", el: null, read: () => ({ proposed: {} }) };
    }

    function step2() {
      const f = fieldsFor(draft.kind);
      sendStep({ q: f.q, el: f.el, read: f.read, back: step1 });
    }

    /* The shared last step: the kind's fields, then note, email, bot check and Send. */
    function sendStep(f) {
      const kind = adding ? "add" : draft.kind;
      const other = kind === "other";
      const note = h("textarea", {
        class: "report-input report-note", rows: other ? 4 : 2, maxlength: "1000",
        placeholder: other ? "Tell me what's wrong" : "Anything else? (optional)",
        "aria-label": other ? "What's wrong" : "Note",
      });
      const email = h("input", {
        type: "email", class: "report-input", autocomplete: "email", maxlength: "200",
        placeholder: "Your email (optional, for follow-ups)",
        "aria-label": "Your email, optional, in case I have a follow-up question",
      });
      // Bots fill every field; people never see this one.
      const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", class: "report-trap", "aria-hidden": "true" });
      const error = h("div", { class: "report-error", role: "alert" });
      const send = h("button", { type: "submit", class: "report-btn report-primary", text: "Send report" });
      // Cloudflare Turnstile. Invisible unless it wants a click, which most people never see.
      const botBox = h("div", { class: "report-bot" });
      const bot = botCheck(botBox, ctx.resize);

      send.addEventListener("click", async () => {
        error.textContent = "";
        const r = f.read();
        if (r.error) { error.textContent = r.error; return; }
        if (other && note.value.trim().length < 5) { error.textContent = "Say a little about what's wrong."; return; }
        if (email.value && !email.checkValidity()) { error.textContent = "That email doesn't look right."; return; }

        send.disabled = true;
        send.textContent = "Sending…";
        try {
          const report = {
            v: 1,
            kind,
            proposed: r.proposed,
            measured: r.measured || null,
            note: note.value.trim() || null,
            email: email.value.trim() || null,
            website: trap.value,
            turnstile: await bot.token(),
            tree: Object.assign({}, t, { struct_id: await structId }),
            page: location.href,
          };
          const resp = await fetch(ENDPOINT(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
          });
          if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.status);
          if (!adding) rememberSent(t.key);
          done();
        } catch (e) {
          bot.reset(); // a Turnstile token is good for one try
          send.disabled = false;
          send.textContent = "Send report";
          error.textContent = "Couldn't send that (" + e.message + "). Try again in a moment?";
        }
      });

      show(
        h("div", { class: "report-q", text: f.q }),
        f.el,
        other ? null : h("div", { class: "report-gap" }),
        note,
        email,
        trap,
        botBox,
        error,
        h("div", { class: "report-actions" },
          h("button", { type: "button", class: "report-btn", text: "Back", onclick: f.back }),
          send),
      );
      leaving = () => bot.remove();
    }

    function done() {
      if (ctx.onSent) ctx.onSent();
      show(
        h("div", { class: "report-q", text: "Thanks! I'll have a look." }),
        h("div", { class: "report-help report-help-top", text: "Once approved, changes should show up within a day." }),
        h("div", { class: "report-actions" },
          h("button", { type: "button", class: "report-btn report-primary", text: "Done", onclick: finish })),
      );
    }

    step1();
    return root;
  }

  /* Cloudflare Turnstile, loaded only once someone reaches the send step. With no site key
   * configured (localhost against dev_server.py) it does nothing and sends no token. */
  let turnstileLoad = null;
  function loadTurnstile() {
    if (!turnstileLoad) {
      turnstileLoad = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        s.async = true;
        s.onload = () => resolve(window.turnstile);
        s.onerror = () => { turnstileLoad = null; reject(new Error("bot check unavailable")); };
        document.head.appendChild(s);
      });
    }
    return turnstileLoad;
  }

  function botCheck(box, onResize) {
    const key = window.TURNSTILE_SITE_KEY;
    if (!key) return { token: async () => null, reset() {}, remove() {} };
    let widget = null;
    let current = null;
    let gone = false;
    const waiters = [];
    const settle = (v) => { current = v; waiters.splice(0).forEach((w) => w(v)); };
    loadTurnstile().then((ts) => {
      if (gone) return;
      widget = ts.render(box, {
        sitekey: key,
        size: "compact",                  // 150 px wide if it ever shows: fits the popup
        appearance: "interaction-only",
        callback: settle,
        "expired-callback": () => { current = null; },
        "error-callback": () => settle(null),
        "before-interactive-callback": onResize,
        "after-interactive-callback": onResize,
      });
    }).catch(() => settle(null));
    return {
      // Usually ready long before Send is pressed; waits up to 15 s if not.
      token: () => current ? Promise.resolve(current)
        : new Promise((resolve) => { waiters.push(resolve); setTimeout(() => resolve(current), 15000); }),
      reset: () => { current = null; if (widget !== null) window.turnstile.reset(widget); },
      remove: () => { gone = true; if (widget !== null) window.turnstile.remove(widget); widget = null; },
    };
  }

  function distance(a, b) {
    const dy = (b.lat - a.lat) * 111320;
    const dx = (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
    const m = Math.hypot(dx, dy);
    return m < 1000 ? `${Math.max(5, Math.round(m / 5) * 5)} m` : `${(m / 1000).toFixed(1)} km`;
  }

  /* The popup sits over the tree and usually hides the preview line, so say which way. */
  function bearing(a, b) {
    const dy = b.lat - a.lat;
    const dx = (b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180);
    const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(deg / 45) % 8];
  }

  function label(x) {
    return x.common && x.common !== x.botanical ? `${x.common} (${x.botanical})` : x.botanical;
  }
  function article(name) {
    const n = name.toLowerCase();
    return (/^[aeiou]/.test(n) ? "an " : "a ") + n;
  }

  window.TreeReport = { button, addForm };
})();

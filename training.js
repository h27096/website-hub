/* Training is isolated from existing Employee/Overseer sessions and Hub modules. */
(function () {
  "use strict";
  const E = window.TrainingEngine;
  let client,
    dialog,
    body,
    status,
    returnFocus,
    profile = null,
    viewId = 0,
    keyHandler = null;
  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function say(text, error = false) {
    status.textContent = text;
    status.className = "training-status" + (error ? " training-error" : "");
  }
  function button(text, fn, parent = body) {
    const n = el("button", text);
    n.type = "button";
    n.onclick = async () => {
      n.disabled = true;
      try {
        await fn();
      } catch (e) {
        say(e.message, true);
      } finally {
        n.disabled = false;
      }
    };
    parent.append(n);
    return n;
  }
  function field(label, value = "", type = "text", parent = body) {
    const l = el("label", label);
    const n = el(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") n.type = type;
    if (type === "checkbox") n.checked = !!value;
    else n.value = value;
    l.append(n);
    parent.append(l);
    return n;
  }
  function select(label, values, value, parent = body) {
    const l = el("label", label),
      n = el("select");
    values.forEach(([v, t]) => {
      const o = el("option", t);
      o.value = v;
      n.append(o);
    });
    n.value = value;
    l.append(n);
    parent.append(l);
    return n;
  }
  function reset(title) {
    viewId++;
    keyHandler = null;
    body.replaceChildren(el("h2", title));
    say("");
    return viewId;
  }
  function authClient() {
    if (!client)
      client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          storageKey: "robco-training-auth",
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      });
    return client;
  }
  async function token() {
    const { data, error } = await authClient().auth.getSession();
    if (error) throw error;
    return data.session?.access_token;
  }
  async function rpc(name, args = {}, admin = false) {
    const jwt = admin ? window.overseerSession?.access_token : await token();
    if (admin && !jwt) throw Error("Sign in to Overseer Mode first.");
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json",
        ...(jwt ? { Authorization: "Bearer " + jwt } : {}),
      },
      body: JSON.stringify(args),
    });
    const data = await r.json();
    if (!r.ok)
      throw Error(
        data.message ||
          "Training unavailable. Apply the Training migration and deploy training-auth.",
      );
    return data;
  }
  async function edge(args, admin = false) {
    const jwt = admin ? window.overseerSession?.access_token : await token();
    if (admin && !jwt) throw Error("Sign in to Overseer Mode first.");
    const r = await fetch(SUPABASE_URL + "/functions/v1/training-auth", {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json",
        ...(jwt ? { Authorization: "Bearer " + jwt } : {}),
      },
      body: JSON.stringify(args),
    });
    const data = await r.json();
    if (!r.ok)
      throw Error(data.error || "Training authentication unavailable.");
    return data;
  }
  function shell() {
    if (!dialog) {
      dialog = el("dialog", undefined, "training-dialog");
      dialog.setAttribute("aria-label", "ROBCO TRAINING CENTER");
      const bar = el("div", undefined, "training-toolbar");
      bar.append(el("strong", "ROBCO // TRAINING CENTER"));
      body = el("div");
      status = el("div", undefined, "training-status");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      dialog.append(bar, status, body);
      button("TRAINING HOME", () => catalog(), bar);
      button("PERSONNEL FILE", () => account(), bar);
      button("CLOSE", () => dialog.close(), bar);
      dialog.addEventListener("close", () => {
        viewId++;
        keyHandler = null;
        returnFocus?.focus();
      });
      dialog.addEventListener("keydown", (e) => {
        if (
          keyHandler &&
          !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
        )
          keyHandler(e);
      });
      document.body.append(dialog);
    }
    if (!dialog.open) {
      returnFocus = document.activeElement;
      dialog.showModal();
    }
  }
  async function loadProfile() {
    profile = null;
    if (await token()) profile = await rpc("training_profile");
    return profile;
  }
  async function account() {
    const id = reset("PERSONNEL FILE");
    try {
      await loadProfile();
    } catch (e) {
      say(e.message, true);
      button("SIGN OUT / CHANGE PERSONNEL FILE", async () => {
        await authClient().auth.signOut();
        profile = null;
        await account();
      });
      return;
    }
    if (id !== viewId) return;
    if (profile) {
      body.append(
        el(
          "p",
          `${profile.callsign} // ${profile.rank} // ${profile.xp} TRAINING XP`,
        ),
        el("p", "Joined " + new Date(profile.joined_at).toLocaleDateString()),
      );
      body.append(
        el(
          "p",
          "XP is your best performance per study set across all modes. Improving accuracy increases XP; replaying an identical result does not.",
          "training-note",
        ),
      );
      button("SIGN OUT", async () => {
        await authClient().auth.signOut();
        profile = null;
        await account();
      });
      stats(profile.statistics, body);
      return;
    }
    body.append(
      el(
        "p",
        "Use a callsign, not a real name. Your Personnel File follows you across devices and Hub domains connected to this Supabase project.",
      ),
    );
    const name = field("Callsign"),
      password = field("Password (12–128 characters)", "", "password");
    name.autocomplete = "username";
    password.autocomplete = "current-password";
    async function submit(action) {
      const data = await edge({
        action,
        callsign: name.value.trim(),
        password: password.value,
      });
      if (!data.session) throw Error("No session returned");
      const { error } = await authClient().auth.setSession(data.session);
      if (error) throw error;
      password.value = "";
      await account();
    }
    button("SIGN INTO PERSONNEL FILE", () => submit("login"));
    button("CREATE PERSONNEL FILE", () => submit("signup"));
    button("FORGOT PASSWORD / RECOVER PERSONNEL FILE", () => recover());
  }
  function recover() {
    reset("RECOVER PERSONNEL FILE");
    body.append(
      el(
        "p",
        "Ask an Overseer to issue a recovery code for your callsign. Codes expire in 45 minutes and work once. Your XP and scores are preserved.",
      ),
    );
    const name = field("Callsign"),
      code = field("Recovery code"),
      pass = field("New password (12–128 characters)", "", "password");
    pass.autocomplete = "new-password";
    button("RESET PASSWORD", async () => {
      const r = await edge({
        action: "recover",
        callsign: name.value.trim(),
        code: code.value,
        password: pass.value,
      });
      pass.value = "";
      code.value = "";
      say(r.message);
    });
  }
  async function catalog(admin = false) {
    const id = reset(admin ? "MANAGE TRAINING CENTER" : "TRAINING LIBRARY");
    const sets = await rpc("training_catalog", { p_admin: admin }, admin);
    if (id !== viewId) return;
    if (admin) button("CREATE STUDY SET", () => editSet());
    else {
      body.append(
        el(
          "p",
          "Browse and practice freely. Sign into a Personnel File to save progress, Training XP and ranked scores.",
        ),
      );
      button("OVERALL TRAINING XP LEADERBOARD", () => leaderboard(null, null));
    }
    const featured = sets.find((s) => s.featured && !s.archived);
    if (featured && !admin) {
      const box = el("div", undefined, "training-featured");
      box.append(
        el(
          "strong",
          `CURRENT TRAINING // ${featured.subject} — ${featured.unit}: ${featured.title}`,
        ),
      );
      button("BEGIN TRAINING", () => study(featured), box);
      body.append(box);
    }
    const subjects = [...new Set(sets.map((s) => s.subject))];
    const sub = select(
      "Subject / Class",
      [["", "ALL SUBJECTS"], ...subjects.map((s) => [s, s])],
      "",
    );
    const unit = select("Unit", [["", "ALL UNITS"]], "");
    const search = field("Search title or topic");
    const list = el("div", undefined, "training-grid");
    body.append(list);
    function units() {
      unit.replaceChildren();
      for (const v of [
        "",
        ...new Set(
          sets
            .filter((s) => !sub.value || s.subject === sub.value)
            .map((s) => s.unit),
        ),
      ]) {
        const o = el("option", v || "ALL UNITS");
        o.value = v;
        unit.append(o);
      }
    }
    function render() {
      list.replaceChildren();
      const rows = sets.filter(
        (s) =>
          (!sub.value || s.subject === sub.value) &&
          (!unit.value || s.unit === unit.value) &&
          (s.title + " " + s.topic)
            .toLowerCase()
            .includes(search.value.toLowerCase()),
      );
      if (!rows.length) list.append(el("p", "No study sets available."));
      rows.forEach((s) => {
        const c = el("article", undefined, "training-card");
        c.append(
          el("h3", s.title),
          el("p", `${s.subject} → ${s.unit} → ${s.topic}`),
          el("p", s.description),
        );
        if (s.archived) c.append(el("p", "ARCHIVED"));
        if (s.featured) c.append(el("p", "FEATURED TRAINING"));
        button(
          admin ? "EDIT STUDY SET" : "OPEN STUDY SET",
          () => (admin ? editSet(s) : study(s)),
          c,
        );
        if (admin)
          button(
            "DUPLICATE",
            async () => {
              const qs = await rpc(
                "training_study",
                { p_set: s.id, p_admin: true },
                true,
              );
              await editSet(
                { ...s, id: null, title: s.title + " (copy)", featured: false },
                qs.map(({ id, ...q }) => q),
              );
            },
            c,
          );
        list.append(c);
      });
    }
    sub.onchange = () => {
      units();
      render();
    };
    unit.onchange = render;
    search.oninput = render;
    units();
    render();
  }
  async function study(set) {
    const id = reset(set.title);
    const qs = await rpc("training_study", { p_set: set.id });
    if (id !== viewId) return;
    body.append(
      el("p", `${set.subject} → ${set.unit} → ${set.topic}`),
      el("p", set.description),
    );
    if (/^https?:\/\//.test(set.source_url)) {
      const a = el("a", "OPEN ORIGINAL SOURCE");
      a.href = set.source_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      body.append(a);
    }
    body.append(el("p", qs.length + " active study items"));
    if (!qs.length) return;
    button("FLASHCARDS", () => flashcards(set, qs));
    for (const [mode, label] of Object.entries(E.modes)) {
      button(label, () => play(set, qs, mode));
      button(label + " LEADERBOARD", () => leaderboard(set, mode));
    }
  }
  async function leaderboard(set, mode) {
    const id = reset(
      set
        ? `${set.title} // ${E.modes[mode]} LEADERBOARD`
        : "TRAINING XP LEADERBOARD",
    );
    const rows = await rpc("training_leaderboard", {
      p_set: set?.id || null,
      p_mode: mode,
    });
    if (id !== viewId) return;
    const table = el("table"),
      head = el("tr");
    ["Callsign", "Score", "Rank"].forEach((t) => head.append(el("th", t)));
    table.append(head);
    rows.forEach((r) => {
      const tr = el("tr");
      [r.callsign, r.score, r.rank].forEach((t) =>
        tr.append(el("td", String(t))),
      );
      table.append(tr);
    });
    body.append(table);
    if (!rows.length) body.append(el("p", "No ranked results yet."));
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  async function flashcards(set, questions) {
    const id = reset("FLASHCARDS // " + set.title);
    await loadProfile();
    if (id !== viewId) return;
    let qs = [...questions],
      i = 0,
      back = false,
      reverse = false;
    const saved = profile?.progress?.find((p) => p.set_id === set.id);
    const valid = new Set(qs.map((q) => q.id));
    const known = new Set((saved?.known || []).filter((x) => valid.has(x))),
      practice = new Set((saved?.practice || []).filter((x) => valid.has(x)));
    const progress = el("p"),
      card = button("", () => {
        back = !back;
        render();
      });
    card.className = "training-flash";
    card.setAttribute("aria-label", "Flip flashcard");
    body.prepend(progress);
    const bar = el("div");
    body.append(bar);
    function render() {
      const q = qs[i],
        rev = reverse && q.kind === "term";
      progress.textContent = `${i + 1} / ${qs.length} // ${known.size} KNOWN // ${practice.size} NEED PRACTICE`;
      card.textContent =
        (back !== rev ? q.answer : q.prompt) +
        "\n\n[ " +
        (back ? "BACK" : "FRONT") +
        " — FLIP ]";
    }
    function move(n) {
      i = (i + n + qs.length) % qs.length;
      back = false;
      render();
    }
    async function mark(ok) {
      const q = qs[i];
      (ok ? known : practice).add(q.id);
      (ok ? practice : known).delete(q.id);
      move(1);
      if (profile) {
        await rpc("training_flash_progress", {
          p_set: set.id,
          p_known: [...known],
          p_practice: [...practice],
        });
        say("Progress saved to Personnel File.");
      } else say("Guest session — sign in to save progress.");
    }
    button("PREVIOUS", () => move(-1), bar);
    button("NEXT", () => move(1), bar);
    button("KNOWN", () => mark(true), bar);
    button("NEEDS PRACTICE", () => mark(false), bar);
    button(
      "SHUFFLE",
      () => {
        shuffle(qs);
        i = 0;
        back = false;
        render();
      },
      bar,
    );
    button(
      "REVERSE TERM CARDS",
      () => {
        reverse = !reverse;
        back = false;
        render();
      },
      bar,
    );
    button(
      "RESTART SESSION",
      () => {
        i = 0;
        back = false;
        render();
      },
      bar,
    );
    keyHandler = (e) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      }
      if (e.key === " " && e.target === dialog) {
        e.preventDefault();
        back = !back;
        render();
      }
    };
    render();
    card.focus();
  }
  async function play(set, bank, mode) {
    const id = reset(E.modes[mode] + " // " + set.title);
    await loadProfile();
    if (id !== viewId) return;
    const run = profile
      ? await rpc("training_start", { p_set: set.id, p_mode: mode })
      : { questions: shuffle([...bank]).slice(0, 20) };
    if (id !== viewId) return;
    let state = E.initial(),
      answers = [],
      action = "",
      lane = "left";
    const area = el("div");
    body.append(area);
    const instructions = {
      quiz: "Answer every question. Typed answers ignore case and surrounding spaces.",
      reactor:
        "Correct answers restore 5 stability and produce power. Errors cost 25 stability. Streaks increase output.",
      terminal:
        "Breach security layers. Every 3 consecutive correct answers earns a utility. Spend one to skip or remove a wrong option. Errors cost 20 integrity.",
      vault:
        "Earn 2 energy per correct answer. Spend 3 before answering on repairs (+25 hull), shields (+20 for the next wave), or defense (+3 permanent). Waves strike every 3 questions and grow stronger.",
      caps: "Choose a lane with arrow keys or touch buttons at each checkpoint. Answer to collect caps. The marked bonus lane adds 20 caps; accuracy builds multipliers. Errors cost 20 fuel.",
    };
    body.insertBefore(el("p", instructions[mode], "training-note"), area);
    function render() {
      area.replaceChildren();
      action = "";
      if (state.index >= run.questions.length || state.hull <= 0) {
        finish();
        return;
      }
      const q = run.questions[state.index];
      const hud = el("div", undefined, "training-hud");
      hud.append(
        el("span", `QUESTION ${state.index + 1}/${run.questions.length}`),
        el("span", `SCORE ${state.score}`),
        el("span", `STREAK ${state.streak}`),
      );
      if (mode !== "quiz")
        hud.append(
          el(
            "span",
            `${mode === "reactor" ? "CORE STABILITY" : mode === "caps" ? "FUEL" : "INTEGRITY"} ${Math.max(0, state.hull)}%`,
          ),
        );
      if (mode === "vault")
        hud.append(
          el(
            "span",
            `ENERGY ${state.energy} // DEFENSE ${state.defense} // SHIELD ${state.shield}`,
          ),
        );
      if (mode === "terminal")
        hud.append(
          el(
            "span",
            `UTILITIES ${state.utility} // LAYER ${state.correct + 1}`,
          ),
        );
      area.append(hud);
      if (mode !== "quiz") {
        const scene = el("div", undefined, "training-scene");
        scene.textContent =
          mode === "reactor"
            ? `[ ⚛ CORE ] ${"▰".repeat(Math.ceil(Math.max(0, state.hull) / 10))} // OUTPUT ${state.score} MW`
            : mode === "terminal"
              ? `[ GATE ${state.correct + 1} ] ──◇── SECURITY LAYERS`
              : mode === "vault"
                ? `⌂ VAULT ┃ ${"▣".repeat(Math.min(12, 1 + state.defense / 3))}  ← WAVE ${Math.floor(state.index / 3) + 1}`
                : `${"· ".repeat(state.index)}[ ROVER ] → CHECKPOINT ${state.index + 1}`;
        area.append(scene);
      }
      const controls = el("div");
      area.append(controls);
      const actionStatus = el("p");
      controls.append(actionStatus);
      if (mode === "vault")
        for (const a of ["repair", "shield", "defense"]) {
          const b = button(
            a.toUpperCase() + " (3 ENERGY)",
            () => {
              action = a;
              actionStatus.textContent =
                "Queued: " + a + " (applies with this answer)";
            },
            controls,
          );
          b.disabled = state.energy < 3;
        }
      if (mode === "caps") {
        lane = state.index % 2 === 0 ? "left" : "right";
        const showLane = () =>
          (actionStatus.textContent = `ROVER: ${lane.toUpperCase()} // BONUS LANE: ${state.index % 2 === 0 ? "LEFT" : "RIGHT"}`);
        button(
          "← LEFT",
          () => {
            lane = "left";
            showLane();
          },
          controls,
        );
        button(
          "RIGHT →",
          () => {
            lane = "right";
            showLane();
          },
          controls,
        );
        keyHandler = (e) => {
          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            lane = e.key === "ArrowLeft" ? "left" : "right";
            showLane();
          }
        };
        showLane();
      }
      area.append(el("h3", q.prompt));
      const choices =
        q.kind === "tf"
          ? ["True", "False"]
          : q.kind === "mc"
            ? shuffle([...q.choices])
            : [];
      const inputs = el("div");
      area.append(inputs);
      let submitted = false;
      function submit(answer) {
        if (submitted) return;
        submitted = true;
        const a = mode === "caps" ? lane : action;
        state = E.step(state, mode, q, answer, a);
        answers.push({ answer, action: a });
        keyHandler = null;
        inputs
          .querySelectorAll("input,button")
          .forEach((n) => (n.disabled = true));
        controls.querySelectorAll("button").forEach((n) => (n.disabled = true));
        const feedback = el(
          "p",
          state.good
            ? "CORRECT // " + q.answer
            : "NEEDS PRACTICE // Answer: " + q.answer,
        );
        feedback.setAttribute("role", "status");
        area.append(feedback);
        button(
          state.index >= run.questions.length || state.hull <= 0
            ? "VIEW RESULTS"
            : "NEXT QUESTION",
          () => render(),
          area,
        ).focus();
      }
      const optionButtons = [];
      if (choices.length)
        choices.forEach((c) =>
          optionButtons.push(button(c, () => submit(c), inputs)),
        );
      else {
        const input = field("Your answer", "", "text", inputs);
        input.autocomplete = "off";
        const b = button("SUBMIT ANSWER", () => submit(input.value), inputs);
        input.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            b.click();
          }
        };
        input.focus();
      }
      if (mode === "terminal") {
        const skip = button(
          "USE UTILITY: SKIP",
          () => {
            action = "skip";
            submit("");
          },
          controls,
        );
        skip.disabled = state.utility < 1;
        const remove = button(
          "USE UTILITY: REMOVE WRONG OPTION",
          () => {
            const b = optionButtons.find((b) => b.textContent !== q.answer);
            if (b) {
              b.disabled = true;
              action = "eliminate";
              actionStatus.textContent = "One utility queued";
              remove.disabled = true;
              skip.disabled = true;
            }
          },
          controls,
        );
        remove.disabled = state.utility < 1 || !choices.length;
      }
    }
    async function finish() {
      keyHandler = null;
      area.replaceChildren(
        el("h3", "TRAINING COMPLETE"),
        el(
          "p",
          `Score ${state.score} // Correct ${state.correct} // Incorrect ${state.index - state.correct} // Accuracy ${Math.round((100 * state.correct) / state.index)}% // ${state.index}/${run.questions.length} answered`,
        ),
      );
      if (!run.id) {
        area.append(
          el(
            "p",
            "GUEST PRACTICE — sign in before a new run to save XP and leaderboard scores.",
          ),
        );
        return;
      }
      const save = button(
        "SAVE / RETRY RESULT",
        async () => {
          const result = await rpc("training_finish", {
            p_run: run.id,
            p_answers: answers,
          });
          await loadProfile();
          save.remove();
          area.append(
            el(
              "p",
              `CLOUD RESULT SAVED // Score ${result.score} // Performance XP ${result.performance_xp} // Total XP ${profile.xp} // ${profile.rank}`,
            ),
          );
        },
        area,
      );
      save.click();
    }
    render();
  }
  function stats(rows, parent) {
    parent.append(el("h3", "GAME STATISTICS / HIGH SCORES"));
    if (!rows?.length) parent.append(el("p", "No completed runs yet."));
    for (const r of rows || [])
      parent.append(
        el(
          "p",
          r.title +
            " // " +
            E.modes[r.mode] +
            " // " +
            r.runs +
            " runs // Best " +
            r.high_score +
            " // " +
            r.correct +
            "/" +
            r.answered +
            " correct",
        ),
      );
  }
  async function personnel() {
    const id = reset("TRAINING PERSONNEL");
    const search = field("Search callsign");
    const results = el("div");
    button("SEARCH PERSONNEL", () => load());
    body.append(results);
    async function load() {
      const rows = await rpc(
        "training_personnel",
        { p_search: search.value },
        true,
      );
      if (id !== viewId) return;
      results.replaceChildren();
      for (const p of rows) {
        const card = el("article", undefined, "training-card");
        card.append(
          el("h3", p.callsign),
          el(
            "p",
            `${p.disabled ? "DISABLED" : "ENABLED"} // ${p.rank} // ${p.xp} XP // Joined ${new Date(p.joined_at).toLocaleDateString()}`,
          ),
        );
        if (p.reset)
          card.append(
            el(
              "p",
              p.reset.state +
                " // " +
                new Date(p.reset.expires_at).toLocaleString(),
            ),
          );
        stats(p.statistics, card);
        button(
          "ISSUE PASSWORD RESET",
          async () => {
            const r = await edge(
              { action: "issue-reset", user_id: p.user_id },
              true,
            );
            await load();
            say(
              r.message +
                "\nGive this code to the user now. It is shown only once:\n" +
                r.code,
            );
          },
          card,
        );
        button(
          "REVOKE OUTSTANDING RESET",
          async () => {
            await rpc(
              "training_moderate",
              { p_user: p.user_id, p_action: "revoke" },
              true,
            );
            await load();
          },
          card,
        );
        button(
          p.disabled ? "RE-ENABLE ACCOUNT" : "DISABLE ACCOUNT",
          async () => {
            await rpc(
              "training_moderate",
              {
                p_user: p.user_id,
                p_action: p.disabled ? "enable" : "disable",
              },
              true,
            );
            await load();
          },
          card,
        );
        const call = field("Moderate callsign", p.callsign, "text", card);
        button(
          "CHANGE CALLSIGN",
          async () => {
            await rpc(
              "training_moderate",
              { p_user: p.user_id, p_action: "callsign", p_value: call.value },
              true,
            );
            await load();
          },
          card,
        );
        for (const best of p.statistics || [])
          button(
            "REMOVE HIGH SCORE: " + best.title + " / " + E.modes[best.mode],
            async () => {
              if (!confirm("Remove this high score and recalculate XP?"))
                return;
              await rpc(
                "training_moderate",
                {
                  p_user: p.user_id,
                  p_action: "invalidate",
                  p_value: best.best_run,
                },
                true,
              );
              await load();
            },
            card,
          );
        const runs = el("details");
        runs.append(el("summary", "VIEW / MODERATE RECENT RUNS"));
        for (const r of p.runs) {
          const line = el("div");
          line.append(
            el(
              "span",
              `${E.modes[r.mode]} // ${r.result?.score} // ${r.result?.accuracy}% // ${r.invalidated ? "REMOVED" : ""}`,
            ),
          );
          if (!r.invalidated)
            button(
              "REMOVE INVALID SCORE",
              async () => {
                if (!confirm("Remove this score and recalculate XP?")) return;
                await rpc(
                  "training_moderate",
                  { p_user: p.user_id, p_action: "invalidate", p_value: r.id },
                  true,
                );
                await load();
              },
              line,
            );
          runs.append(line);
        }
        let offset = p.runs.length;
        button(
          "LOAD OLDER RUNS",
          async () => {
            const older = await rpc(
              "training_personnel_runs",
              { p_user: p.user_id, p_offset: offset },
              true,
            );
            offset += older.length;
            if (!older.length) {
              say("No older runs.");
              return;
            }
            for (const r of older) {
              const line = el("div");
              line.append(
                el(
                  "span",
                  E.modes[r.mode] +
                    " // " +
                    r.result?.score +
                    " // " +
                    (r.invalidated ? "REMOVED" : ""),
                ),
              );
              if (!r.invalidated)
                button(
                  "REMOVE INVALID SCORE",
                  async () => {
                    if (!confirm("Remove this score and recalculate XP?"))
                      return;
                    await rpc(
                      "training_moderate",
                      {
                        p_user: p.user_id,
                        p_action: "invalidate",
                        p_value: r.id,
                      },
                      true,
                    );
                    await load();
                  },
                  line,
                );
              runs.append(line);
            }
          },
          runs,
        );
        card.append(runs);
        const confirmation = field(
          "Permanent deletion: type DELETE " + p.callsign,
          "",
          "text",
          card,
        );
        button(
          "DELETE ACCOUNT PERMANENTLY",
          async () => {
            if (confirmation.value !== `DELETE ${p.callsign}`)
              throw Error("Type the exact confirmation phrase.");
            if (
              !confirm(
                "Permanently delete this Personnel File, progress and all scores?",
              )
            )
              return;
            await edge(
              {
                action: "delete",
                user_id: p.user_id,
                confirmation: confirmation.value,
              },
              true,
            );
            await load();
          },
          card,
        );
        results.append(card);
      }
      if (!rows.length) results.append(el("p", "No matching Personnel Files."));
    }
    await load();
  }
  async function editSet(set = {}, copied = null) {
    const id = reset(set.id ? "EDIT STUDY SET" : "CREATE STUDY SET");
    const qs =
      copied ||
      (set.id
        ? await rpc("training_study", { p_set: set.id, p_admin: true }, true)
        : []);
    if (id !== viewId) return;
    const fields = {};
    for (const [k, label] of [
      ["title", "Title"],
      ["subject", "Subject / Class"],
      ["unit", "Unit"],
      ["topic", "Topic"],
      ["description", "Description"],
      ["source_url", "Source URL (optional; never scraped)"],
    ])
      fields[k] = field(
        label,
        set[k] || "",
        k === "description" ? "textarea" : "text",
      );
    const archived = field("Archived", set.archived, "checkbox"),
      featured = field("Featured Training", set.featured, "checkbox");
    const editor = el("div");
    body.append(editor);
    let rows = [];
    function add(
      q = { kind: "term", prompt: "", answer: "", choices: [], active: true },
    ) {
      const card = el("fieldset", undefined, "training-card");
      card.append(el("legend", "QUESTION"));
      const row = { id: q.id, node: card };
      row.kind = select(
        "Type",
        [
          ["term", "Term / Definition"],
          ["mc", "Multiple Choice"],
          ["tf", "True / False"],
          ["typed", "Typed Answer"],
        ],
        q.kind,
        card,
      );
      row.prompt = field("Term / Question", q.prompt, "textarea", card);
      row.answer = field(
        "Answer (True or False for True / False)",
        q.answer,
        "textarea",
        card,
      );
      row.choices = field(
        "Multiple choice options — one per line",
        (q.choices || []).join("\n"),
        "textarea",
        card,
      );
      row.active = field("Active", q.active, "checkbox", card);
      button(
        "REMOVE QUESTION",
        () => {
          card.remove();
          rows = rows.filter((r) => r !== row);
        },
        card,
      );
      rows.push(row);
      editor.append(card);
    }
    qs.forEach(add);
    button("ADD QUESTION", () => add());
    const importer = el("details");
    importer.append(el("summary", "BULK PASTE / CSV / TSV IMPORT"));
    body.append(importer);
    const delimiter = select(
      "Format",
      [
        ["|", "Term | Definition"],
        [",", "CSV"],
        ["\t", "TSV"],
      ],
      "|",
      importer,
    );
    const paste = field("Study material", "", "textarea", importer);
    const file = field(
      "Or select a UTF-8 CSV / TSV file",
      "",
      "file",
      importer,
    );
    file.accept = ".csv,.tsv,.txt";
    file.onchange = async () => {
      try {
        if (!file.files[0]) return;
        if (file.files[0].size > 1000000) throw Error("Maximum file size 1 MB");
        paste.value = await file.files[0].text();
        delimiter.value = file.files[0].name.endsWith(".csv")
          ? ","
          : file.files[0].name.endsWith(".tsv")
            ? "\t"
            : "|";
      } catch (e) {
        say(e.message, true);
      }
    };
    const preview = el("div");
    importer.append(preview);
    button(
      "PREVIEW IMPORT",
      () => {
        preview.replaceChildren();
        const parsed = E.parseImport(paste.value, delimiter.value);
        if (parsed.errors.length) {
          preview.append(el("pre", parsed.errors.join("\n")));
          return;
        }
        preview.append(
          el(
            "p",
            parsed.questions.length + " valid items — review before adding",
          ),
        );
        const list = el("ol");
        parsed.questions.forEach((q) =>
          list.append(el("li", q.prompt + " → " + q.answer)),
        );
        preview.append(list);
        button(
          "ADD PREVIEWED ITEMS",
          () => {
            if (rows.length + parsed.questions.length > 500)
              throw Error("Maximum 500 questions per set");
            parsed.questions.forEach(add);
            preview.replaceChildren(
              el("p", "Items added to editor. Save the study set to publish."),
            );
          },
          preview,
        );
      },
      importer,
    );
    button("SAVE STUDY SET", async () => {
      const data = Object.fromEntries(
        Object.entries(fields).map(([k, n]) => [k, n.value.trim()]),
      );
      data.archived = archived.checked;
      data.featured = featured.checked;
      if (data.archived && data.featured)
        throw Error("Archived sets cannot be featured.");
      if (!data.title || !data.subject || !data.unit)
        throw Error("Title, subject and unit are required.");
      const questions = rows.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        kind: r.kind.value,
        prompt: r.prompt.value.trim(),
        answer: r.answer.value.trim(),
        choices:
          r.kind.value === "mc"
            ? r.choices.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        active: r.active.checked,
      }));
      await rpc(
        "training_save_set",
        {
          p_set: set.id || null,
          p_data: data,
          p_questions: questions,
          p_revision: set.revision || null,
        },
        true,
      );
      await catalog(true);
      say("Study set saved.");
    });
    if (set.id) {
      const conf = field("To delete permanently, type DELETE STUDY SET");
      button("DELETE STUDY SET", async () => {
        if (conf.value !== "DELETE STUDY SET")
          throw Error("Exact confirmation required.");
        if (!confirm("Delete this set, its questions, related scores and XP?"))
          return;
        await rpc(
          "training_delete_set",
          { p_set: set.id, p_confirmation: conf.value },
          true,
        );
        await catalog(true);
      });
    }
  }
  window.openTraining = async function (mode = "catalog") {
    shell();
    try {
      if (mode === "manage") await catalog(true);
      else if (mode === "personnel") await personnel();
      else await catalog();
    } catch (e) {
      say(e.message, true);
    }
  };
})();

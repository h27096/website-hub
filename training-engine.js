/* Pure single-player rules. Future live hosts can supply the same questions/player
   and replay these actions. SQL independently validates ranked submissions. */
(function (root) {
  const modes = {
    quiz: "QUIZ",
    reactor: "⚛ REACTOR RUSH",
    terminal: "💻 TERMINAL HACK",
    vault: "🛡 VAULT DEFENSE",
    caps: "🪙 CAPS RUN",
  };
  const rank = (x) =>
    x >= 5000
      ? "ROBCO SPECIALIST"
      : x >= 2000
        ? "SENIOR TECHNICIAN"
        : x >= 750
          ? "TECHNICIAN"
          : x >= 200
            ? "JUNIOR TECHNICIAN"
            : "TRAINEE";
  const initial = () => ({
    score: 0,
    correct: 0,
    streak: 0,
    hull: 100,
    energy: 0,
    shield: 0,
    defense: 0,
    utility: 0,
    index: 0,
  });
  function step(state, mode, question, answer, action = "") {
    const s = { ...state };
    if (s.hull <= 0) throw Error("Run ended");
    if (action) {
      if (
        mode === "vault" &&
        ["repair", "shield", "defense"].includes(action) &&
        s.energy >= 3
      ) {
        s.energy -= 3;
        if (action === "repair") s.hull = Math.min(100, s.hull + 25);
        else if (action === "shield") s.shield += 20;
        else s.defense += 3;
      } else if (
        mode === "terminal" &&
        ["skip", "eliminate"].includes(action) &&
        s.utility > 0
      )
        s.utility--;
      else if (!(mode === "caps" && ["left", "right"].includes(action)))
        throw Error("Invalid or unaffordable action");
    }
    const good =
      answer.trim().toLowerCase() === question.answer.trim().toLowerCase() &&
      action !== "skip";
    s.streak = good ? s.streak + 1 : 0;
    if (good) s.correct++;
    if (mode === "quiz" && good) s.score += 100;
    if (mode === "reactor") {
      if (good) {
        s.score += 100 + Math.min(s.streak, 5) * 10;
        s.hull = Math.min(100, s.hull + 5);
      } else s.hull -= 25;
    }
    if (mode === "terminal") {
      if (good) {
        s.score += 120;
        if (s.streak % 3 === 0) s.utility = Math.min(3, s.utility + 1);
      } else if (action !== "skip") s.hull -= 20;
    }
    if (mode === "vault") {
      if (good) {
        s.energy += 2;
        s.score += 100;
      }
      if ((s.index + 1) % 3 === 0) {
        s.hull -= Math.max(
          0,
          15 + Math.floor((s.index + 1) / 3) * 5 - s.defense - s.shield,
        );
        s.shield = 0;
        if (s.hull > 0) s.score += 50;
      }
    }
    if (mode === "caps") {
      if (good)
        s.score +=
          50 * Math.min(s.streak, 4) +
          ((s.index % 2 === 0 && action === "left") ||
          (s.index % 2 === 1 && action === "right")
            ? 20
            : 0);
      else s.hull -= 20;
    }
    s.index++;
    return { ...s, good };
  }
  function parseImport(text, delimiter = "|") {
    if (text.length > 1000000) throw Error("Import exceeds 1 MB");
    // RFC-style quoted fields, including escaped quotes and multiline values.
    const rows = [];
    let row = [],
      field = "",
      quoted = false,
      closed = false;
    for (let i = 0; i <= text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === undefined) throw Error("Unclosed quoted field");
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
            closed = true;
          }
        } else field += c;
        continue;
      }
      if (c === '"' && !field && !closed) {
        quoted = true;
        continue;
      }
      if (c === delimiter || c === "\n" || c === undefined) {
        row.push(field.trim());
        field = "";
        closed = false;
        if (c !== delimiter) {
          if (row.some(Boolean)) rows.push(row);
          row = [];
        }
        continue;
      }
      if (c === "\r" && text[i + 1] === "\n") continue;
      if (closed && c.trim())
        throw Error("Unexpected text after closing quote");
      field += c;
    }
    if (
      rows.length &&
      /^(term|prompt)$/i.test(rows[0][0]) &&
      /^(definition|answer)$/i.test(rows[0][1])
    )
      rows.shift();
    const errors = [];
    const questions = rows.map((r, i) => {
      if (r.length !== 2 || !r[0] || !r[1] || r.some((x) => x.length > 2000))
        errors.push(
          `Row ${i + 1}: expected exactly two nonempty fields, maximum 2000 characters each.`,
        );
      return {
        kind: "term",
        prompt: r[0],
        answer: r[1],
        choices: [],
        active: true,
      };
    });
    if (questions.length > 500) errors.push("Maximum 500 questions per set.");
    if (!questions.length) errors.push("No questions found.");
    return { questions, errors };
  }
  const api = { modes, rank, initial, step, parseImport };
  root.TrainingEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

const assert = require("node:assert/strict"),
  E = require("../training-engine");
assert.deepEqual([0, 199, 200, 749, 750, 1999, 2000, 4999, 5000].map(E.rank), [
  "TRAINEE",
  "TRAINEE",
  "JUNIOR TECHNICIAN",
  "JUNIOR TECHNICIAN",
  "TECHNICIAN",
  "TECHNICIAN",
  "SENIOR TECHNICIAN",
  "SENIOR TECHNICIAN",
  "ROBCO SPECIALIST",
]);
assert.equal(
  E.parseImport("Mitochondria | ATP\nNucleus | DNA").questions.length,
  2,
);
assert.equal(
  E.parseImport('term,definition\n"a,b","x"\n"multi\nline","say ""hi"""', ",")
    .questions[1].answer,
  'say "hi"',
);
assert.equal(E.parseImport("A\tB", "\t").questions[0].answer, "B");
assert(E.parseImport("a|b|c").errors.length);
assert(E.parseImport("a|").errors.length);
assert.throws(() => E.parseImport('"open|a'), /Unclosed/);
for (const mode of Object.keys(E.modes)) {
  let s = E.initial();
  for (let i = 0; i < 5; i++) s = E.step(s, mode, { answer: " Yes " }, "yes");
  assert.equal(s.correct, 5);
  assert(s.score > 0);
}
assert.throws(
  () => E.step(E.initial(), "vault", { answer: "A" }, "A", "repair"),
  /unaffordable/,
);
let t = E.initial();
for (let i = 0; i < 3; i++) t = E.step(t, "terminal", { answer: "A" }, "A");
assert.equal(t.utility, 1);
t = E.step(t, "terminal", { answer: "A" }, "", "skip");
assert.equal(t.utility, 0);
assert.equal(t.hull, 100);
assert.equal(t.correct, 3);
console.log(
  "PASS Training engine: rank boundaries, CSV/TSV validation, scoring, utility budget",
);

const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  E = require("../training-engine.js");
const admin = "11111111-1111-4111-8111-111111111111",
  user = "22222222-2222-4222-8222-222222222222",
  other = "33333333-3333-4333-8333-333333333333";
async function setup() {
  const db = new PGlite();
  await db.exec(
    `create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; create table public.overseers(user_id uuid references auth.users); insert into auth.users values('${admin}'),('${user}'),('${other}'); insert into public.overseers values('${admin}'); grant usage on schema public,auth to anon,authenticated,service_role; create table public.existing_module(value text); insert into public.existing_module values('preserved');`,
  );
  await db.exec(
    fs.readFileSync(
      require("node:path").join(
        __dirname,
        "../supabase/migrations/20261005_training_center.sql",
      ),
      "utf8",
    ),
  );
  await db.query(
    "insert into public.training_profiles(user_id,callsign) values($1,$2),($3,$4)",
    [user, "Trainee", other, "Other"],
  );
  const as = async (role, uid, name, args = []) => {
    await db.exec("set role " + role);
    await db.query(
      "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [uid || "", JSON.stringify({ iat: Math.floor(Date.now() / 1000) + 5 })],
    );
    try {
      return (
        await db.query(
          `select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) as result`,
          args,
        )
      ).rows[0].result;
    } finally {
      await db.exec("reset role");
    }
  };
  return { db, as };
}
module.exports = { setup, admin, user, other };
if (require.main === module)
  (async () => {
    const { db, as } = await setup();
    try {
      const meta = {
        title: "Cells",
        subject: "SCIENCE",
        unit: "UNIT 4",
        featured: true,
      };
      const qs = Array.from({ length: 12 }, (_, i) => ({
        kind:
          i % 4 === 0
            ? "mc"
            : i % 4 === 1
              ? "tf"
              : i % 4 === 2
                ? "typed"
                : "term",
        prompt: "Question " + i,
        answer: i % 4 === 1 ? "True" : "ATP",
        choices: i % 4 === 0 ? ["ATP", "DNA"] : [],
        active: true,
      }));
      for (const [role, uid] of [
        ["anon", null],
        ["authenticated", user],
      ])
        for (const [name, args] of [
          ["training_personnel", [""]],
          ["training_personnel_runs", [user, 0]],
          ["training_statistics", [user]],
          ["training_save_set", [null, meta, qs, null]],
          ["training_moderate", [user, "disable", ""]],
          ["training_delete_set", [user, "DELETE STUDY SET"]],
          ["training_issue_reset", [user, "hash", admin]],
          ["training_claim_reset", ["Trainee", "hash"]],
        ])
          await assert.rejects(
            as(role, uid, name, args),
            /permission denied|Overseer access denied/,
          );
      const set = await as("authenticated", admin, "training_save_set", [
        null,
        meta,
        qs,
        null,
      ]);
      assert.equal(
        (await as("anon", null, "training_catalog", [false]))[0].featured,
        true,
      );
      const bank = await as("anon", null, "training_study", [set, false]);
      assert.equal(bank.length, 12);
      for (const table of [
        "training_profiles",
        "training_runs",
        "training_resets",
        "training_questions",
        "training_progress",
        "training_limits",
      ]) {
        await db.exec("set role authenticated");
        await assert.rejects(
          db.query("select * from public." + table),
          /permission denied/,
        );
        await assert.rejects(
          db.query("delete from public." + table),
          /permission denied/,
        );
        await db.exec("reset role");
      }
      for (const mode of Object.keys(E.modes)) {
        const run = await as("authenticated", user, "training_start", [
          set,
          mode,
        ]);
        let state = E.initial();
        const answers = [];
        for (const q of run.questions) {
          let action =
            mode === "caps"
              ? state.index % 2
                ? "right"
                : "left"
              : mode === "vault" && state.energy >= 3
                ? "shield"
                : "";
          const answer = state.index % 4 === 0 ? "wrong" : q.answer;
          state = E.step(state, mode, q, answer, action);
          answers.push({ answer, action });
          if (state.hull <= 0) break;
        }
        await assert.rejects(
          as("authenticated", other, "training_finish", [run.id, answers]),
          /Run not found/,
        );
        await assert.rejects(
          as("authenticated", user, "training_finish", [
            run.id,
            [{ answer: "ATP", score: 999999999 }],
          ]),
          /Malformed answer/,
        );
        const result = await as("authenticated", user, "training_finish", [
          run.id,
          answers,
        ]);
        assert.equal(result.score, state.score, mode);
        assert.equal(result.correct, state.correct);
        await assert.rejects(
          as("authenticated", user, "training_finish", [run.id, answers]),
          /already submitted/,
        );
        const summary = (
          await as("authenticated", user, "training_profile")
        ).statistics.find((r) => r.mode === mode);
        assert.equal(summary.high_score, state.score);
        assert.equal(summary.runs, 1);
        const board = await as("anon", null, "training_leaderboard", [
          set,
          mode,
        ]);
        assert.deepEqual(Object.keys(board[0]).sort(), [
          "callsign",
          "rank",
          "score",
        ]);
      }
      const perfect = await as("authenticated", user, "training_start", [
        set,
        "quiz",
      ]);
      await assert.rejects(
        as("authenticated", user, "training_finish", [
          perfect.id,
          [{ answer: "ATP", action: "repair" }],
        ]),
        /Invalid or unaffordable/,
      );
      await assert.rejects(
        as("authenticated", user, "training_finish", [
          perfect.id,
          [{ answer: "ATP" }],
        ]),
        /Complete the run/,
      );
      await as("authenticated", user, "training_finish", [
        perfect.id,
        perfect.questions.map((q) => ({ answer: q.answer })),
      ]);
      assert.equal(
        (await as("authenticated", user, "training_profile")).xp,
        125,
      );
      const replay = await as("authenticated", user, "training_start", [
        set,
        "quiz",
      ]);
      await as("authenticated", user, "training_finish", [
        replay.id,
        replay.questions.map((q) => ({ answer: q.answer })),
      ]);
      assert.equal(
        (await as("authenticated", user, "training_profile")).xp,
        125,
      );
      await as("authenticated", user, "training_flash_progress", [
        set,
        [bank[0].id],
        [bank[1].id],
      ]);
      assert.equal(
        (await as("authenticated", user, "training_profile")).progress[0]
          .known[0],
        bank[0].id,
      );
      await as("authenticated", admin, "training_moderate", [
        user,
        "disable",
        "",
      ]);
      await assert.rejects(
        as("authenticated", user, "training_profile"),
        /enabled Personnel/,
      );
      await as("authenticated", admin, "training_moderate", [
        user,
        "enable",
        "",
      ]);
      assert.equal(
        (await as("authenticated", user, "training_profile")).xp,
        125,
      );
      await as("authenticated", admin, "training_moderate", [
        user,
        "callsign",
        "NewCall",
      ]);
      assert.equal(
        (await as("authenticated", user, "training_profile")).callsign,
        "NewCall",
      );
      await as("service_role", null, "training_issue_reset", [
        user,
        "hash1",
        admin,
      ]);
      await assert.rejects(
        as("service_role", null, "training_claim_reset", ["NewCall", "wrong"]),
        /Invalid or expired/,
      );
      assert.equal(
        await as("service_role", null, "training_claim_reset", [
          "NewCall",
          "hash1",
        ]),
        user,
      );
      await assert.rejects(
        as("service_role", null, "training_claim_reset", ["NewCall", "hash1"]),
        /Invalid or expired/,
      );
      assert.equal(
        (await as("authenticated", user, "training_profile")).xp,
        125,
      );
      await db.query(
        "update public.training_resets set state='PASSWORD RESET COMPLETED' where user_id=$1",
        [user],
      );
      assert.equal(
        (await as("authenticated", admin, "training_personnel", ["NewCall"]))[0]
          .reset.state,
        "PASSWORD RESET COMPLETED",
      );
      await as("service_role", null, "training_issue_reset", [
        user,
        "hash2",
        admin,
      ]);
      await as("authenticated", admin, "training_moderate", [
        user,
        "revoke",
        "",
      ]);
      await assert.rejects(
        as("service_role", null, "training_claim_reset", ["NewCall", "hash2"]),
        /Invalid or expired/,
      );
      await as("service_role", null, "training_issue_reset", [
        user,
        "hash3",
        admin,
      ]);
      await db.exec(
        "update public.training_resets set expires_at=now()-interval '1 minute'",
      );
      await assert.rejects(
        as("service_role", null, "training_claim_reset", ["NewCall", "hash3"]),
        /Invalid or expired/,
      );
      assert.equal(
        (await as("authenticated", admin, "training_personnel", ["NewCall"]))[0]
          .reset.state,
        "RESET EXPIRED",
      );
      assert(
        !JSON.stringify(
          await as("authenticated", admin, "training_personnel", [""]),
        ).includes("code_hash"),
      );
      const current = (
        await as("authenticated", admin, "training_catalog", [true])
      )[0];
      await as("authenticated", admin, "training_save_set", [
        set,
        { ...meta, featured: false, archived: true },
        [bank[1], { ...bank[2], active: false }],
        current.revision,
      ]);
      await assert.rejects(
        as("anon", null, "training_study", [set, false]),
        /unavailable/,
      );
      assert.equal(
        (await as("authenticated", admin, "training_study", [set, true]))
          .length,
        2,
      );
      await assert.rejects(
        as("authenticated", admin, "training_save_set", [set, meta, bank, 1]),
        /changed/,
      );
      const archived = (
        await as("authenticated", admin, "training_catalog", [true])
      )[0];
      await as("authenticated", admin, "training_save_set", [
        set,
        meta,
        [bank[1], { ...bank[2], active: false }],
        archived.revision,
      ]);
      assert.equal(
        (await as("anon", null, "training_study", [set, false])).length,
        1,
      );
      for (let i = 0; i < 15; i++)
        assert.equal(
          await as("service_role", null, "training_rate_limit", ["test"]),
          true,
        );
      assert.equal(
        await as("service_role", null, "training_rate_limit", ["test"]),
        false,
      );
      await as("authenticated", admin, "training_moderate", [
        user,
        "invalidate",
        perfect.id,
      ]);
      assert.equal(
        (await as("authenticated", user, "training_profile")).xp,
        125,
      );
      await as("authenticated", admin, "training_moderate", [
        user,
        "invalidate",
        replay.id,
      ]);
      assert((await as("authenticated", user, "training_profile")).xp < 125);
      assert.equal(
        (await db.query("select value from public.existing_module")).rows[0]
          .value,
        "preserved",
      );
      console.log(
        "PASS Training DB: permissions, canonical bank, edit/archive, score replay, XP, ranks, progress, disable, resets, privacy, moderation, rate limits",
      );
    } finally {
      await db.close();
    }
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

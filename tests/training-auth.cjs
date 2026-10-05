/* Real Edge handler + local PostgreSQL + isolated Auth transport. No live writes. */
const assert = require("node:assert/strict");
const {setupEdge} = require("./training-auth-fixture.cjs");
(async () => {
  const {db, as, handler, users, auth, call, controls, admin, user} = await setupEdge({TRAINING_CORS_MODE: "restricted"});
  try {
    const health = await handler(new Request("https://local.test", {headers: {origin: "https://hub.test"}}));
    assert.equal(health.status, 200);
    const readiness = await health.json();
    assert.equal(readiness.ready, true);
    assert.equal(readiness.cors.mode, "restricted");
    assert.equal((await db.query("select count(*)::int n from public.training_limits")).rows[0].n, 0);
    controls.failProfile = true;
    const failedInsert = await call({action: "signup", callsign: "Rollback", password: "a-long-fixture-password"});
    assert.equal(failedInsert.body.code, "42501");
    assert.equal(failedInsert.body.operation, "Training profile creation");
    assert.equal(failedInsert.body.identity_created, false);
    assert.equal(users.size, 2);
    controls.failCleanup = true;
    const orphan = await call({action: "signup", callsign: "Repair", password: "a-long-fixture-password"});
    assert.equal(orphan.body.code, "PROFILE_CLEANUP_FAILED");
    assert.equal(orphan.body.identity_created, true);
    assert.equal(orphan.body.profile_created, false);
    controls.failCleanup = controls.failProfile = false;
    // Remove only the isolated fixture orphan, not production accounts.
    for (const id of users.keys()) if (![admin,user].includes(id)) await auth.admin.deleteUser(id);
    controls.failLogin = true;
    const partial = await call({action: "signup", callsign: "CreatedAlready", password: "a-long-fixture-password"});
    assert.equal(partial.status, 503);
    assert.equal(partial.body.identity_created, true);
    assert.equal(partial.body.profile_created, true);
    assert.equal(partial.body.upstream_status, 503);
    assert.match(partial.body.error, /Sign in with the same callsign/);
    assert(!partial.body.error.includes("a-long-fixture-password"));
    controls.failLogin = false;
    assert.equal((await call({action: "login", callsign: "CreatedAlready", password: "a-long-fixture-password"})).status, 200);
    const created = await call({
      action: "signup",
      callsign: "CloudUser",
      password: "a-long-fixture-password",
    });
    assert.equal(created.status, 200);
    const id = created.body.session.access_token.slice(6);
    assert(users.get(id).email.endsWith("@training.invalid"));
    const profile = await as("authenticated", id, "training_profile");
    assert.equal(profile.callsign, "CloudUser");
    assert.equal(profile.xp, 0);
    assert.equal(profile.rank, "TRAINEE");
    assert.equal(
      (
        await call({
          action: "login",
          callsign: "clouduser",
          password: "a-long-fixture-password",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call({
          action: "login",
          callsign: "CloudUser",
          password: "incorrect-password",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call({
          action: "signup",
          callsign: "CLOUDUSER",
          password: "a-long-fixture-password",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call({ action: "signup", callsign: "Unsafe", password: "short" }))
        .status,
      400,
    );
    assert.equal(
      (await call({ action: "issue-reset", user_id: id }, "user-jwt")).status,
      403,
    );
    const issued = await call(
      { action: "issue-reset", user_id: id },
      "admin-jwt",
    );
    assert.equal(issued.status, 200);
    assert.match(issued.body.code, /^[0-9a-f]{64}$/);
    const stored = (
      await db.query(
        "select code_hash from public.training_resets where user_id=$1",
        [id],
      )
    ).rows[0];
    assert.notEqual(stored.code_hash, issued.body.code);
    const reset = {
      action: "recover",
      callsign: "CloudUser",
      code: issued.body.code,
      password: "a-new-fixture-password",
    };
    assert.equal((await call(reset)).status, 200);
    assert.equal((await call(reset)).status, 400);
    assert.equal(
      (
        await call({
          action: "login",
          callsign: "CloudUser",
          password: "a-long-fixture-password",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call({
          action: "login",
          callsign: "CloudUser",
          password: "a-new-fixture-password",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await db.query(
          "select callsign from public.training_profiles where user_id=$1",
          [id],
        )
      ).rows[0].callsign,
      "CloudUser",
    );
    await as("authenticated", admin, "training_moderate", [id, "disable", ""]);
    const disabled = await call({action: "login", callsign: "CloudUser", password: "a-new-fixture-password"});
    assert.equal(disabled.status, 400);
    assert.equal(disabled.body.code, "ACCOUNT_DISABLED");
    await as("authenticated", admin, "training_moderate", [id, "enable", ""]);
    const failure = await call(
      { action: "issue-reset", user_id: id },
      "admin-jwt",
    );
    controls.failPassword = true;
    assert.equal(
      (await call({ ...reset, code: failure.body.code })).status,
      503,
    );
    controls.failPassword = false;
    assert.equal(
      (await call({ ...reset, code: failure.body.code })).status,
      400,
    );
    assert.equal(
      (
        await call(
          { action: "delete", user_id: id, confirmation: "DELETE CloudUser" },
          "user-jwt",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          { action: "delete", user_id: id, confirmation: "yes" },
          "admin-jwt",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          { action: "delete", user_id: id, confirmation: "DELETE CloudUser" },
          "admin-jwt",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await db.query(
          "select * from public.training_profiles where user_id=$1",
          [id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (await call({ action: "signup" }, "", "https://unknown.test")).status,
      403,
    );
    console.log(
      "PASS real Edge handler: signup, duplicate cleanup, login, recovery once, changed password, disable, failure closed, admin authorization, deletion confirmation, CORS",
    );
  } finally {
    await db.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

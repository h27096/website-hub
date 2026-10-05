/* Execute the real Edge handler against local PostgreSQL and an isolated Auth
   transport fixture. Never calls a live Supabase project. */
const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { stripTypeScriptTypes } = require("node:module");
const { setup, admin, user } = require("./training-db.cjs");
(async () => {
  const { db, as } = await setup();
  let handler;
  const users = new Map([
    [admin, { id: admin, email: "admin@example.test", app_metadata: {} }],
    [
      user,
      {
        id: user,
        email: "fixture@training.invalid",
        app_metadata: { robco_training: true },
      },
    ],
  ]);
  const passwords = new Map();
  let failPassword = false;
  let failProfile = false, failLogin = false, failCleanup = false;
  function from(table) {
    let operation = "select",
      data,
      filters = [],
      single = false,
      columns = "*";
    const b = {
      select(c = "*") {
        columns = c;
        return b;
      },
      insert(d) {
        operation = "insert";
        data = d;
        return b;
      },
      update(d) {
        operation = "update";
        data = d;
        return b;
      },
      eq(k, v) {
        filters.push([k, "=", v]);
        return b;
      },
      ilike(k, v) {
        filters.push([k, "ilike", v]);
        return b;
      },
      single() {
        single = true;
        return b;
      },
      maybeSingle() {
        single = true;
        return b;
      },
      then(resolve, reject) {
        return (async () => {
          try {
            const params = [];
            let query;
            if (operation === "select")
              query = `select ${columns} from public.${table}`;
            else {
              if (table === "training_profiles" && operation === "insert" && failProfile)
                throw Object.assign(Error("permission denied for table training_profiles"), {code: "42501"});
              const keys = Object.keys(data);
              params.push(...Object.values(data));
              query =
                operation === "insert"
                  ? `insert into public.${table}(${keys}) values(${keys.map((_, i) => "$" + (i + 1))})`
                  : `update public.${table} set ${keys.map((k, i) => k + "=$" + (i + 1))}`;
            }
            if (filters.length)
              query +=
                " where " +
                filters
                  .map(([k, op, v]) => {
                    params.push(v);
                    return k + " " + op + " $" + params.length;
                  })
                  .join(" and ");
            if (operation !== "select") query += " returning " + columns;
            const r = await db.query(query, params);
            return { data: single ? r.rows[0] || null : r.rows, error: null };
          } catch (error) {
            return { data: null, error };
          }
        })().then(resolve, reject);
      },
    };
    return b;
  }
  const auth = {
    admin: {
      async createUser(b) {
        const u = {
          id: crypto.randomUUID(),
          email: b.email,
          app_metadata: b.app_metadata,
        };
        users.set(u.id, u);
        passwords.set(u.id, b.password);
        await db.query("insert into auth.users values($1)", [u.id]);
        return { data: { user: u }, error: null };
      },
      async deleteUser(id) {
        if (failCleanup) return {data: null, error: Error("cleanup unavailable")};
        users.delete(id);
        passwords.delete(id);
        await db.query("delete from auth.users where id=$1", [id]);
        return { data: {}, error: null };
      },
      async updateUserById(id, b) {
        if (failPassword)
          return { error: Error("Auth unavailable"), data: null };
        passwords.set(id, b.password);
        return { data: { user: users.get(id) }, error: null };
      },
      async getUserById(id) {
        return { data: { user: users.get(id) }, error: null };
      },
    },
    async getUser(jwt) {
      return {
        data: {
          user:
            jwt === "admin-jwt"
              ? users.get(admin)
              : jwt === "user-jwt"
                ? users.get(user)
                : null,
        },
        error: null,
      };
    },
    async signInWithPassword(b) {
      if (failLogin) return {data: null, error: Object.assign(Error("Auth unavailable password=" + b.password), {status: 503, code: "unexpected_failure"})};
      const u = [...users.values()].find((u) => u.email === b.email);
      return u && passwords.get(u.id) === b.password
        ? {
            data: {
              session: {
                access_token: "token-" + u.id,
                refresh_token: "refresh-" + u.id,
              },
            },
            error: null,
          }
        : { data: null, error: Error("Bad credentials") };
    },
  };
  const createClient = () => ({
    auth,
    from,
    rpc: async (name, args) => {
      try {
        return {
          data: await as("service_role", null, name, Object.values(args)),
          error: null,
        };
      } catch (error) {
        return { data: null, error };
      }
    },
  });
  const source = fs
    .readFileSync(
      require("node:path").join(
        __dirname,
        "../supabase/functions/training-auth/index.ts",
      ),
      "utf8",
    )
    .replace(/^import .*;\r?\n/, "");
  vm.runInNewContext(stripTypeScriptTypes(source), {
    createClient,
    Deno: {
      env: {
        get: (k) =>
          k === "TRAINING_ALLOWED_ORIGINS" ? "https://hub.test" : "fixture",
      },
      serve: (fn) => (handler = fn),
    },
    crypto: crypto.webcrypto,
    TextEncoder,
    Response,
    console,
  });
  async function call(body, jwt = "", origin = "https://hub.test") {
    await db.exec("delete from public.training_limits");
    const r = await handler(
      new Request("https://local.test", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          authorization: "Bearer " + jwt,
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: await r.json() };
  }
  try {
    const health = await handler(new Request("https://local.test", {headers: {origin: "https://hub.test"}}));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {ready: true});
    assert.equal((await db.query("select count(*)::int n from public.training_limits")).rows[0].n, 0);
    failProfile = true;
    const failedInsert = await call({action: "signup", callsign: "Rollback", password: "a-long-fixture-password"});
    assert.equal(failedInsert.body.code, "42501");
    assert.equal(failedInsert.body.operation, "Training profile creation");
    assert.equal(failedInsert.body.identity_created, false);
    assert.equal(users.size, 2);
    failCleanup = true;
    const orphan = await call({action: "signup", callsign: "Repair", password: "a-long-fixture-password"});
    assert.equal(orphan.body.code, "PROFILE_CLEANUP_FAILED");
    assert.equal(orphan.body.identity_created, true);
    assert.equal(orphan.body.profile_created, false);
    failCleanup = failProfile = false;
    // Remove only the isolated fixture orphan, not production accounts.
    for (const id of users.keys()) if (![admin,user].includes(id)) await auth.admin.deleteUser(id);
    failLogin = true;
    const partial = await call({action: "signup", callsign: "CreatedAlready", password: "a-long-fixture-password"});
    assert.equal(partial.status, 503);
    assert.equal(partial.body.identity_created, true);
    assert.equal(partial.body.profile_created, true);
    assert.equal(partial.body.upstream_status, 503);
    assert.match(partial.body.error, /Sign in with the same callsign/);
    assert(!partial.body.error.includes("a-long-fixture-password"));
    failLogin = false;
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
    failPassword = true;
    assert.equal(
      (await call({ ...reset, code: failure.body.code })).status,
      503,
    );
    failPassword = false;
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

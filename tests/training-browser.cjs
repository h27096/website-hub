const { chromium } = require("playwright"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  http = require("node:http"),
  path = require("node:path");
const { setup, admin, user } = require("./training-db.cjs");
const root = path.resolve(__dirname, "..");
(async () => {
  const { db, as } = await setup();
  let queue = Promise.resolve();
  const sql = (...args) => {
    const task = queue.then(() => as(...args));
    queue = task.catch(() => {});
    return task;
  };
  const meta = {
    title: "Cells",
    subject: "SCIENCE",
    unit: "UNIT 4",
    topic: "Organelles",
    featured: true,
  };
  const set = await sql("authenticated", admin, "training_save_set", [
    null,
    meta,
    [
      { kind: "term", prompt: "Mitochondria", answer: "ATP", active: true },
      {
        kind: "mc",
        prompt: "Energy?",
        answer: "ATP",
        choices: ["ATP", "DNA"],
        active: true,
      },
      {
        kind: "tf",
        prompt: "Cells have membranes",
        answer: "True",
        active: true,
      },
      { kind: "typed", prompt: "Energy molecule", answer: "ATP", active: true },
    ],
    null,
  ]);
  const server = http.createServer((req, res) => {
    const p = path.resolve(
      root,
      "." + (req.url === "/" ? "/index.html" : req.url.split("?")[0]),
    );
    if (!p.startsWith(root + path.sep) || !fs.existsSync(p)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      p.endsWith(".js")
        ? "text/javascript"
        : p.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(fs.readFileSync(p));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || "msedge",
  });
  const errors = [];
  const mockSDK = `window.supabase={createClient:(u,k,o)=>({auth:{getSession:async()=>({data:{session:o?.auth?.storageKey==='robco-personnel-v14'?null:JSON.parse(localStorage.getItem('test-training-session')||'null')}}),setSession:async(s)=>{localStorage.setItem('test-training-session',JSON.stringify(s));return{};},signOut:async()=>{localStorage.removeItem('test-training-session');return{};}}})};`;
  async function prepare(page) {
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://cdn.jsdelivr.net/**", (r) =>
      r.fulfill({ contentType: "text/javascript", body: mockSDK }),
    );
    await page.route("https://*.supabase.co/**", async (r) => {
      const req = r.request(),
        name = new URL(req.url()).pathname.split("/").pop(),
        body = JSON.parse(req.postData() || "{}");
      let result = [];
      try {
        if (name === "use_access_code") {
          result = {success: body.input_code === "normal-test-password"};
        } else if (name === "training-auth") {
          if (req.method() === "GET") return r.fulfill({contentType: "application/json", body: JSON.stringify({ready: true})});
          result =
            body.action === "recover"
              ? {
                  message:
                    "PASSWORD RESET COMPLETED. Sign in with your new password.",
                }
              : {
                  session: {
                    access_token: "training-user",
                    refresh_token: "fixture",
                  },
                };
        } else if (name.startsWith("training_")) {
          const jwt = req.headers().authorization;
          const actor =
            jwt === "Bearer admin"
              ? admin
              : jwt === "Bearer training-user"
                ? user
                : null;
          const signatures = {
            training_catalog: ["p_admin"],
            training_study: ["p_set", "p_admin"],
            training_profile: [],
            training_start: ["p_set", "p_mode"],
            training_finish: ["p_run", "p_answers"],
            training_flash_progress: ["p_set", "p_known", "p_practice"],
            training_leaderboard: ["p_set", "p_mode"],
            training_save_set: ["p_set", "p_data", "p_questions", "p_revision"],
            training_personnel: ["p_search"],
            training_personnel_runs: ["p_user", "p_offset"],
            training_moderate: ["p_user", "p_action", "p_value"],
          };
          const args = (signatures[name] || []).map(
            (k) =>
              body[k] ??
              (k === "p_admin" ? false : k === "p_value" ? "" : null),
          );
          result = await sql(
            actor ? "authenticated" : "anon",
            actor,
            name,
            args,
          );
        }
        return r.fulfill({
          contentType: "application/json",
          body: JSON.stringify(result),
        });
      } catch (e) {
        return r.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ message: e.message }),
        });
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await hubLogin(page);
  }
  async function hubLogin(page) {
    const entry = page.getByRole("button", {name: "ROBCO TRAINING CENTER", exact: true});
    assert.equal(await entry.isVisible(), false);
    await page.evaluate(() => openTraining());
    assert.equal(await page.locator('.training-dialog[open]').count(), 0);
    await page.locator('#accessCode').fill('wrong-password');
    await page.evaluate(() => login());
    assert.equal(await entry.isVisible(), false);
    await page.locator('#accessCode').fill('normal-test-password');
    await page.evaluate(() => login());
    assert.equal(await entry.isVisible(), true);
  }
  try {
    const page = await browser.newPage();
    await prepare(page);
    await page
      .getByRole("button", { name: "ROBCO TRAINING CENTER", exact: true })
      .click();
    const d = page.getByRole("dialog", { name: "ROBCO TRAINING CENTER" });
    await d.getByText("CURRENT TRAINING // SCIENCE — UNIT 4: Cells").waitFor();
    await d
      .getByRole("button", { name: "BEGIN TRAINING", exact: true })
      .click();
    await d.getByRole("button", { name: "FLASHCARDS", exact: true }).click();
    await d.getByRole("button", { name: "Flip flashcard" }).click();
    assert(
      (
        await d.getByRole("button", { name: "Flip flashcard" }).textContent()
      ).includes("ATP"),
    );
    await page.keyboard.press("ArrowRight");
    assert((await d.textContent()).includes("2 / 4"));
    await d.getByRole("button", { name: "KNOWN", exact: true }).click();
    await d.getByRole("button", { name: "SHUFFLE", exact: true }).click();
    await d
      .getByRole("button", { name: "RESTART SESSION", exact: true })
      .click();
    await d
      .getByRole("button", { name: "PERSONNEL FILE", exact: true })
      .click();
    await d.getByLabel("Callsign", { exact: true }).fill("Trainee");
    await d
      .getByLabel("Password (12–128 characters)")
      .fill("safe-test-password");
    await d
      .getByRole("button", { name: "SIGN INTO PERSONNEL FILE", exact: true })
      .click();
    await d.getByText(/Trainee \/\/ TRAINEE/).waitFor();
    await page.reload();
    await hubLogin(page);
    await page
      .getByRole("button", { name: "ROBCO TRAINING CENTER", exact: true })
      .click();
    await d
      .getByRole("button", { name: "PERSONNEL FILE", exact: true })
      .click();
    await d.getByText(/Trainee \/\/ TRAINEE/).waitFor();
    for (const label of [
      "QUIZ",
      "⚛ REACTOR RUSH",
      "💻 TERMINAL HACK",
      "🛡 VAULT DEFENSE",
      "🪙 CAPS RUN",
    ]) {
      await d
        .getByRole("button", { name: "TRAINING HOME", exact: true })
        .click();
      await d
        .getByRole("button", { name: "BEGIN TRAINING", exact: true })
        .click();
      await d.getByRole("button", { name: label, exact: true }).click();
      fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
      await d.getByText("QUESTION 1/4", { exact: true }).waitFor();
      await page.screenshot({
        path: path.join(
          root,
          "test-results/training-" + label.replace(/[^A-Za-z]/g, "") + ".png",
        ),
      });
      for (let i = 0; i < 4; i++) {
        await d.getByText(`QUESTION ${i + 1}/4`, { exact: true }).waitFor();
        if (label.includes("CAPS")) await page.keyboard.press("ArrowLeft");
        if (await d.getByLabel("Your answer", { exact: true }).count()) {
          await d.getByLabel("Your answer", { exact: true }).fill("ATP");
          await d
            .getByRole("button", { name: "SUBMIT ANSWER", exact: true })
            .click();
        } else if (
          await d.getByRole("button", { name: "ATP", exact: true }).count()
        )
          await d.getByRole("button", { name: "ATP", exact: true }).click();
        else await d.getByRole("button", { name: "True", exact: true }).click();
        await d
          .getByRole("button", {
            name: i === 3 ? "VIEW RESULTS" : "NEXT QUESTION",
            exact: true,
          })
          .click();
      }
      await d.getByText(/CLOUD RESULT SAVED/).waitFor();
    }
    assert.equal(
      (await sql("authenticated", user, "training_profile")).xp,
      125,
    );
    await page.evaluate(() => {
      window.overseerSession = { access_token: "admin" };
      return openTraining("manage");
    });
    await d
      .getByRole("button", { name: "CREATE STUDY SET", exact: true })
      .click();
    await d.getByLabel("Title", { exact: true }).fill("Imported");
    await d.getByLabel("Subject / Class", { exact: true }).fill("SCIENCE");
    await d.getByLabel("Unit", { exact: true }).fill("UNIT 5");
    await d.getByText("BULK PASTE / CSV / TSV IMPORT", { exact: true }).click();
    await d.getByLabel("Study material", { exact: true }).fill("A | B\nBad");
    await d
      .getByRole("button", { name: "PREVIEW IMPORT", exact: true })
      .click();
    await d.getByText(/Row 2: expected exactly/).waitFor();
    await d.getByLabel("Study material", { exact: true }).fill("A | B\nC | D");
    await d
      .getByRole("button", { name: "PREVIEW IMPORT", exact: true })
      .click();
    await d
      .getByRole("button", { name: "ADD PREVIEWED ITEMS", exact: true })
      .click();
    await d
      .getByRole("button", { name: "SAVE STUDY SET", exact: true })
      .click();
    await d.getByRole("heading", { name: "Imported", exact: true }).waitFor();
    await page.evaluate(() => openTraining("personnel"));
    await d.getByRole("heading", { name: "Trainee", exact: true }).waitFor();
    await d
      .getByRole("button", { name: "DISABLE ACCOUNT", exact: true })
      .last()
      .click();
    await d.getByRole("button", { name: "CLOSE", exact: true }).click();
    assert(!(await d.isVisible()));
    const mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await prepare(mobile);
    await mobile
      .getByRole("button", { name: "ROBCO TRAINING CENTER", exact: true })
      .tap();
    const md = mobile.getByRole("dialog", { name: "ROBCO TRAINING CENTER" });
    await md.getByRole("button", { name: "BEGIN TRAINING", exact: true }).tap();
    await md.getByRole("button", { name: "🪙 CAPS RUN", exact: true }).tap();
    await md.getByRole("button", { name: "RIGHT →", exact: true }).tap();
    await md.getByText(/ROVER: RIGHT/).waitFor();
    assert(await md.evaluate((n) => n.scrollWidth <= n.clientWidth));
    await md.getByRole("button", { name: "TRAINING HOME", exact: true }).tap();
    await md.getByRole("button", { name: "BEGIN TRAINING", exact: true }).tap();
    await md.getByRole("button", { name: "FLASHCARDS", exact: true }).tap();
    await md.getByRole("button", { name: "Flip flashcard" }).tap();
    assert(
      (
        await md.getByRole("button", { name: "Flip flashcard" }).textContent()
      ).includes("ATP"),
    );
    fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
    await mobile.screenshot({
      path: path.join(root, "test-results/training-mobile.png"),
    });
    await mobile.evaluate(() => logout());
    assert.equal(await md.isVisible(), false);
    assert.equal(await mobile.getByRole('button', {name:'ROBCO TRAINING CENTER', exact:true}).isVisible(), false);
    await mobile.evaluate(() => openTraining());
    assert.equal(await md.isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(
      "PASS Training browser: featured/library, sign-in/refresh, cloud results for all five modes, flashcards, imports/editor, personnel, touch controls, mobile overflow",
    );
  } finally {
    await browser.close();
    server.close();
    await db.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

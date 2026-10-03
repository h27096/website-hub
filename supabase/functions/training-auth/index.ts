import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const allowed = (Deno.env.get("TRAINING_ALLOWED_ORIGINS") || "")
  .split(",")
  .map((s) => s.trim());
const digest = async (s: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const passwordOK = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 12 && s.length <= 128;
const callOK = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9_-]{3,24}$/.test(s);
function checked<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw Error("Operation failed");
  return r.data;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers":
      "authorization,apikey,content-type,x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  if (origin && !allowed.includes(origin))
    return reply({ error: "Origin not configured" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return reply({ error: "POST required" }, 405);
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const text = await req.text();
    if (text.length > 4096) return reply({ error: "Request too large" }, 413);
    const b = JSON.parse(text);
    // Edge gateway supplies forwarding headers. Also throttle callsign independently
    // so rotating/falsifying an address cannot remove a target's attempt budget.
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const ipOK = checked(
      await admin.rpc("training_rate_limit", {
        p_key: await digest("ip:" + ip),
      }),
    );
    const nameOK = checked(
      await admin.rpc("training_rate_limit", {
        p_key: await digest(
          "name:" + String(b.callsign || b.user_id || "").toLowerCase(),
        ),
      }),
    );
    if (!ipOK || !nameOK)
      return reply({ error: "Too many attempts. Wait 15 minutes." }, 429);
    if (["signup", "login", "recover"].includes(b.action)) {
      if (!callOK(b.callsign) || !passwordOK(b.password))
        return reply(
          {
            error:
              "Use a 3–24 character callsign (letters, numbers, _ or -) and a 12–128 character password.",
          },
          400,
        );
      if (b.action === "signup") {
        const email = `${crypto.randomUUID()}@training.invalid`;
        const user = checked(
          await admin.auth.admin.createUser({
            email,
            password: b.password,
            email_confirm: true,
            app_metadata: { robco_training: true },
          }),
        ).user;
        if (!user) throw Error("Account creation failed");
        const { error } = await admin
          .from("training_profiles")
          .insert({ user_id: user.id, callsign: b.callsign });
        if (error) {
          await admin.auth.admin.deleteUser(user.id);
          return reply(
            { error: "Callsign unavailable or account creation failed." },
            400,
          );
        }
        const session = checked(
          await admin.auth.signInWithPassword({ email, password: b.password }),
        ).session;
        return reply({ session });
      }
      if (b.action === "recover") {
        if (
          typeof b.code !== "string" ||
          !/^[a-f0-9]{64}$/i.test(b.code.replace(/\s/g, ""))
        )
          return reply({ error: "Invalid or expired recovery code" }, 400);
        const uid = checked(
          await admin.rpc("training_claim_reset", {
            p_callsign: b.callsign,
            p_hash: await digest(b.code.replace(/\s/g, "").toLowerCase()),
          }),
        );
        // Claim is atomic: concurrent requests cannot reuse the same code. Fail closed
        // if Auth is unavailable; the Overseer can issue a fresh code after failure.
        const changed = await admin.auth.admin.updateUserById(uid, {
          password: b.password,
        });
        const state = changed.error
          ? "RESET FAILED"
          : "PASSWORD RESET COMPLETED";
        checked(
          await admin
            .from("training_resets")
            .update({ state })
            .eq("user_id", uid)
            .eq("state", "PROCESSING")
            .select("id"),
        );
        if (changed.error)
          return reply(
            {
              error:
                "Reset could not complete. Ask the Overseer for a new code.",
            },
            503,
          );
        return reply({
          message: "PASSWORD RESET COMPLETED. Sign in with your new password.",
        });
      }
      const profile = checked(
        await admin
          .from("training_profiles")
          .select("user_id,disabled")
          .ilike("callsign", b.callsign.replace(/_/g, "\\_"))
          .maybeSingle(),
      );
      if (!profile || profile.disabled) throw Error("Invalid credentials");
      const user = checked(
        await admin.auth.admin.getUserById(profile.user_id),
      ).user;
      const session = checked(
        await admin.auth.signInWithPassword({
          email: user.email!,
          password: b.password,
        }),
      ).session;
      return reply({ session });
    }
    const jwt = (req.headers.get("authorization") || "").replace(
      /^Bearer /i,
      "",
    );
    const actor = checked(await admin.auth.getUser(jwt)).user;
    if (!actor) return reply({ error: "Overseer access denied" }, 403);
    const overseer = checked(
      await admin
        .from("overseers")
        .select("user_id")
        .eq("user_id", actor.id)
        .maybeSingle(),
    );
    if (!overseer) return reply({ error: "Overseer access denied" }, 403);
    const p = checked(
      await admin
        .from("training_profiles")
        .select("user_id,callsign")
        .eq("user_id", b.user_id)
        .single(),
    );
    if (b.action === "issue-reset") {
      const code = [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      checked(
        await admin.rpc("training_issue_reset", {
          p_user: p.user_id,
          p_hash: await digest(code),
          p_actor: actor.id,
        }),
      );
      return reply({
        code,
        message:
          "PASSWORD RESET ISSUED // WAITING FOR USER // expires in 45 minutes",
      });
    }
    if (b.action === "delete") {
      if (b.confirmation !== `DELETE ${p.callsign}`)
        return reply({ error: "Exact confirmation required" }, 400);
      // Refuse deletion of an Auth identity that also has an existing Overseer role.
      const role = checked(
        await admin
          .from("overseers")
          .select("user_id")
          .eq("user_id", p.user_id)
          .maybeSingle(),
      );
      const user = checked(await admin.auth.admin.getUserById(p.user_id)).user;
      if (role || user.app_metadata?.robco_training !== true)
        return reply(
          { error: "Protected account; cannot delete through Training" },
          403,
        );
      checked(await admin.auth.admin.deleteUser(p.user_id));
      return reply({ message: "Personnel File deleted" });
    }
    return reply({ error: "Unknown action" }, 400);
  } catch {
    return reply(
      {
        error:
          "Unable to complete request. Check credentials, recovery code, permissions and server setup.",
      },
      400,
    );
  }
});

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// The Hub is a public static application that can move between domains. CORS
// permits transport; passwords, verified bearer JWTs and RPC/RLS authorize data.
// No cookies or Access-Control-Allow-Credentials are used. Operators can opt
// into an exact-origin policy without hard-coding any hosting domain in code.
const corsMode = Deno.env.get("TRAINING_CORS_MODE") || "public";
const allowed = (Deno.env.get("TRAINING_ALLOWED_ORIGINS") || "").split(",")
  .map((s) => {
    try {
      const u = new URL(s.trim());
      return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash ? u.origin : "";
    } catch { return ""; }
  }).filter(Boolean);
const corsHeaders = ["authorization", "apikey", "content-type", "x-client-info"];
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
function checked<T>(r: { data: T; error: any }): T {
  if (r.error) throw r.error;
  return r.data;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const configured = ["public", "restricted"].includes(corsMode) && (corsMode !== "restricted" || allowed.length > 0);
  const originAllowed = configured && (corsMode === "public" || !origin || allowed.includes(origin));
  const headers = {
    // Readiness contains no private data. Keep even configuration failures
    // readable so a restricted-origin deployment can explain its rejection.
    "Access-Control-Allow-Origin": corsMode === "public" || req.method === "GET" ? "*" : originAllowed ? origin : "",
    "Access-Control-Allow-Headers": corsHeaders.join(","),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  if (!configured) return reply({error: "Invalid TRAINING_CORS_MODE or empty restricted-origin list.", code: "BACKEND_CONFIGURATION", operation: "CORS configuration"}, 503);
  if (!originAllowed)
    return reply({ error: "This origin is not allowed in restricted CORS mode. Update TRAINING_ALLOWED_ORIGINS or use public CORS mode for the public Hub.", code: "ORIGIN_NOT_CONFIGURED", operation: "CORS origin check" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!url || !key) return reply({error: "Training backend environment is incomplete.", code: "BACKEND_CONFIGURATION", operation: "backend configuration"}, 503);
  // Readiness probe: no Auth/table calls, attempt counters or secrets.
  if (req.method === "GET") return reply({ ready: true, cors: {mode: corsMode, origin_allowed: originAllowed, methods: ["GET", "POST", "OPTIONS"], headers: corsHeaders} });
  if (req.method !== "POST") return reply({ error: "POST required" }, 405);
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Keep password exchanges from replacing the service client's Authorization.
  const loginClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let operation = "request validation", identityCreated = false, profileCreated = false;
  const secrets = [key, req.headers.get("authorization") || ""];
  const safe = (value: unknown) => {
    let message = String(value || "Operation failed");
    for (const secret of secrets) if (secret) message = message.split(secret).join("[REDACTED]");
    return message.replace(/Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(?:secret|publishable)_\S+|\b[a-f0-9]{64}\b/gi, "[REDACTED]")
      .replace(/((?:password|access_token|refresh_token|recovery_code|service_role_key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 400);
  };
  try {
    const text = await req.text();
    if (text.length > 4096) return reply({ error: "Request too large" }, 413);
    const b = JSON.parse(text);
    secrets.push(String(b.password || ""), String(b.code || ""));
    operation = "RPC training_rate_limit";
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
        operation = "duplicate callsign check";
        const existing = checked(await admin.from("training_profiles").select("user_id")
          .ilike("callsign", b.callsign.replace(/_/g, "\\_" )).maybeSingle());
        if (existing) return reply({error: "Callsign unavailable. Sign in if you already created this Personnel File.", code: "CALLSIGN_UNAVAILABLE", operation}, 400);
        const email = `${crypto.randomUUID()}@training.invalid`;
        operation = "Auth identity creation";
        const user = checked(
          await admin.auth.admin.createUser({
            email,
            password: b.password,
            email_confirm: true,
            app_metadata: { robco_training: true },
          }),
        ).user;
        if (!user) throw Error("Account creation failed");
        identityCreated = true;
        operation = "Training profile creation";
        const { error } = await admin
          .from("training_profiles")
          .insert({ user_id: user.id, callsign: b.callsign });
        if (error) {
          const cleanup = await admin.auth.admin.deleteUser(user.id);
          identityCreated = !!cleanup.error;
          if (cleanup.error) throw {code: "PROFILE_CLEANUP_FAILED", message: "Auth identity was created, but profile creation and rollback failed. Ask the Overseer to repair this account before retrying registration."};
          if (error.code === "23505") return reply({error: "Callsign unavailable.", code: "CALLSIGN_UNAVAILABLE", operation}, 400);
          throw error;
        }
        profileCreated = true;
        operation = "Auth password exchange after account creation";
        const session = checked(
          await loginClient.auth.signInWithPassword({ email, password: b.password }),
        ).session;
        if (!session) throw Error("Auth returned no session");
        return reply({ session });
      }
      if (b.action === "recover") {
        operation = "RPC training_claim_reset";
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
        operation = "Auth password recovery";
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
      operation = "Training profile lookup for sign-in";
      const profile = checked(
        await admin
          .from("training_profiles")
          .select("user_id,disabled")
          .ilike("callsign", b.callsign.replace(/_/g, "\\_"))
          .maybeSingle(),
      );
      if (!profile) return reply({error: "Invalid callsign or password.", code: "INVALID_CREDENTIALS", operation: "sign-in"}, 400);
      operation = "Auth identity lookup";
      const user = checked(
        await admin.auth.admin.getUserById(profile.user_id),
      ).user;
      operation = "Auth password exchange";
      const signedIn = await loginClient.auth.signInWithPassword({
          email: user.email!,
          password: b.password,
        });
      if (signedIn.error && (signedIn.error.code === "invalid_credentials" || signedIn.error.message === "Bad credentials"))
        return reply({error: "Invalid callsign or password.", code: "INVALID_CREDENTIALS", operation}, 400);
      const session = checked(signedIn).session;
      if (profile.disabled) return reply({error: "Personnel File disabled. Contact an Overseer.", code: "ACCOUNT_DISABLED", operation: "account-disabled check"}, 400);
      if (!session) throw Error("Auth returned no session");
      return reply({ session });
    }
    const jwt = (req.headers.get("authorization") || "").replace(
      /^Bearer /i,
      "",
    );
    secrets.push(jwt);
    operation = "Overseer authorization";
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
      operation = "RPC training_issue_reset";
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
      operation = "Overseer account deletion";
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
  } catch (e: any) {
    const sanitizedCode = safe(e?.code || "TRAINING_AUTH_FAILED");
    const code = /^[A-Za-z0-9_-]{1,64}$/.test(sanitizedCode) ? sanitizedCode : "TRAINING_AUTH_FAILED";
    const error = safe(e?.message) + (identityCreated ? (profileCreated
      ? " Personnel File was created. Sign in with the same callsign/password; do not create another account."
      : " Auth identity exists but its Training profile is not linked; Overseer repair is required.") : "");
    console.warn(JSON.stringify({operation, code, error, identity_created: identityCreated, profile_created: profileCreated}));
    return reply(
      {
        error, code, operation, upstream_status: Number(e?.status) || null,
        identity_created: identityCreated, profile_created: profileCreated,
      },
      e?.status >= 500 ? 503 : 400,
    );
  }
});

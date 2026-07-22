# Inkwell — multi-author revenue-share blog

A Next.js 16 (App Router) + Supabase + TipTap blog where authors write, admins
approve, and every unique daily reader pays the author $0.002.

## Stack

- **Next.js 16** (App Router, Server Actions, Server Components)
- **Tailwind CSS v4** (CSS-first config, no `tailwind.config.js` needed)
- **Supabase** (Postgres, Auth, Row Level Security)
- **TipTap v3** (rich text, stored as JSON, rendered to sanitized HTML)

## Setup

1. `npm install`
2. Create a Supabase project, then in the SQL editor run `supabase/schema.sql`
   top to bottom.
3. `.env.local` already has your project URL and anon key filled in (both
   safe to be public — see "About that Supabase key" below). You still need
   to add `SUPABASE_SERVICE_ROLE_KEY` yourself from Project Settings → API →
   `service_role` — that one's a real secret and shouldn't be pasted
   anywhere but there. `.env.local` is gitignored either way.
4. `npm run dev`, sign up an account at `/login`, then promote yourself to
   admin from the Supabase SQL editor:
   ```sql
   update public.users set role = 'admin' where email = 'you@example.com';
   ```
   (Every new sign-up gets `role = 'author'` by default via the
   `handle_new_user` trigger — there's no client-facing way to self-assign
   admin, by design.)

> **Already ran schema.sql before?** Re-running the whole file will error on
> `create type`/`create table` (they already exist). Just run the new bits
> standalone — the `prevent_privilege_escalation()`, `platform_stats()`, and
> `author_bylines()` blocks — `create or replace function` is safe to run on
> its own, as is the fixed trigger definition.

## About that Supabase key

The anon/public key is *meant* to be public — it's shipped inside the
JavaScript bundle of every Supabase app that exists. It doesn't grant access
to anything by itself; Row Level Security (all of `supabase/schema.sql`) is
what actually decides who can read or write what, regardless of who holds
this key. That's why it's fine to have in `.env.local` and even fine if it
ends up in your deployed site's bundle — that's the intended design.

The key that must stay secret is `service_role` — it bypasses RLS entirely.
Get it only from your Supabase dashboard, put it only in `.env.local` or
your hosting platform's environment variables, and never paste it into a
chat, a commit, or anywhere else.

## Two bugs I caught by actually running this against real Postgres

Everything up to this point had only been verified with `tsc`/`next build` —
which check that the code compiles, not that the database logic is correct.
I installed Postgres locally and ran the real `schema.sql` against it with
simulated `anon`/`authenticated` roles, and found two bugs `tsc` could never
have caught:

1. **The documented admin-promotion step didn't work.** Running
   `update public.users set role = 'admin' where email = '...'` in the SQL
   editor was blocked by `prevent_privilege_escalation()` — its trigger fired
   regardless of who ran the UPDATE, including a superuser. There was no way
   to ever create an admin account. The same root cause silently blocked
   `track_article_view()`'s balance credit too — the anti-fraud feature this
   app is built around. Fixed by gating the trigger on
   `auth.uid() is not null` (a real end-user session) instead of just
   `is_admin()`, so a privileged/session-less context (SQL editor, or a
   `SECURITY DEFINER` function like `track_article_view()`) passes through,
   while a genuinely logged-in non-admin is still correctly blocked. Re-
   verified: admin promotion, a non-admin failing to self-promote, a
   non-admin failing to credit their own balance, a non-admin successfully
   updating their own `stripe_account_id`, and the full view → credit →
   dedupe-by-IP flow.
2. **Author bylines were silently broken on every public page.** The
   homepage, article pages, and per-article OG images all fetched the author
   via a PostgREST embed (`articles.select('..., author:users(email)')`).
   RLS on `users` correctly denies anonymous SELECT, so that embed just came
   back `null` for every logged-out visitor — every byline would have
   silently rendered "Staff Writer" instead of the real author, in
   production, for anyone not logged in. Fixed with `author_bylines()` (a
   `SECURITY DEFINER` function, only returns emails for authors with at
   least one *published* article) plus `lib/authors.ts`. Re-verified: an
   anonymous role correctly resolves the byline of a published article, and
   an author with only unpublished drafts still isn't leaked.

## Deploy (GitHub → Vercel)

1. Push this repo to GitHub (`.gitignore` already keeps `node_modules`,
   `.env*.local`, and build output out of it — never commit `.env.local`).
2. In Vercel: **New Project → Import** your GitHub repo. Framework preset
   auto-detects Next.js; no build command changes needed.
3. Add the four variables from `.env.local.example` under **Project Settings
   → Environment Variables**:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — safe to be
     public, but still set them as env vars rather than hardcoding.
   - `SUPABASE_SERVICE_ROLE_KEY` — **do not** prefix with `NEXT_PUBLIC_`. It
     must stay server-only.
   - `NEXT_PUBLIC_SITE_URL` — set to your real Vercel/custom domain (e.g.
     `https://your-app.vercel.app`), not `localhost`. It's used to decide
     whether a link in an article is "external" for the sponsored-nofollow
     rule, and to build `sitemap.xml`/`robots.txt`.
4. In Supabase, go to **Authentication → URL Configuration** and set **Site
   URL** and **Redirect URLs** to your real domain — otherwise signup
   confirmation emails will link back to `localhost`.
5. Deploy. Every push to your default branch redeploys automatically.

## How the pieces fit together

- **`supabase/schema.sql`** — tables, RLS policies, and
  `track_article_view()`, the function that atomically checks the 24-hour
  window and credits the author's balance. It's revoked from `anon`/
  `authenticated`, so the only way to call it is through the API route below
  using the service-role key.
- **`app/api/track-view/route.ts`** — reads the caller's IP from request
  headers (never from the client body) and calls that function.
- **`lib/tiptap-extensions.ts`** — one shared extension set used by both the
  live editor and the public-page HTML renderer, so the `rel="sponsored
  nofollow"` rule on external links is computed from the href at render time
  rather than stored — there's no code path that can skip it.
- **`proxy.ts`** (Next.js 16's renamed `middleware.ts`) — redirects logged-out
  users for a smoother UX only. Next.js middleware/proxy has a real history of
  authorization-bypass CVEs (see the comment in that file), so every
  protected Server Component and Server Action independently re-checks
  `auth.getUser()` and role, and Postgres RLS is the actual backstop
  underneath all of it.
- **`platform_stats()`** (in `schema.sql`) — the homepage's "Published /
  Writers / Earned by writers" strip is a real aggregate query, not
  placeholder numbers. It's a `SECURITY DEFINER` function granted to `anon`
  specifically because it returns *only* totals — never a per-user row,
  balance, or email — so it's safe to expose publicly, unlike loosening the
  `users` table's RLS would be.
- **`lib/utils.ts`** — `estimateReadingTime` / `extractExcerpt` walk the
  TipTap JSON to derive reading time and description text, and
  `formatAuthorName` turns an email into a byline (e.g. `jane.doe@…` →
  "Jane Doe") without a schema change. View counts are intentionally *not*
  shown publicly — they stay visible only to the author and admins, per the
  `views` RLS policy — showing them on the homepage would mean either
  leaking raw view rows (IP addresses) or building another aggregate
  function; reading time gets most of the "this is a real publication"
  feeling without that trade-off.
- **`app/authors/[id]`** — public author profile pages, built on top of
  `author_bylines()` + a normal published-articles query (already public via
  existing RLS, no new backend needed for that half). An author with zero
  published articles 404s rather than showing an empty profile, so the
  existence of an unpublished account is never confirmable from the URL.
- **`lib/coverArt.ts` / `components/ArticleCover.tsx`** — deterministic
  generative cover art (gradient + motif, hashed from the article id) instead
  of requiring image uploads or Supabase Storage setup. Same article always
  renders the same cover; no two require any new infrastructure.
- **Homepage search** — a plain `ILIKE` title match via `?q=`, no schema
  change. Full tagging/categorization would need a real migration (a `tags`
  table or column, plus editor UI for assigning them) — deliberately left
  out of this pass rather than rushed; happy to build it as a follow-up if
  you want it.
- **`components/gsap/`** — `HeroReveal` (entrance timeline for above-the-fold
  content), `RevealGroup` (`ScrollTrigger.batch`-based stagger reveal for
  article grids), `ReadingProgress` (scrub-linked progress bar on article
  pages). All three wrap already-server-rendered children/props rather than
  re-fetching anything, and all respect `prefers-reduced-motion` via
  `gsap.matchMedia()` — reduced-motion visitors get the content immediately,
  no animation, not just a faster version of one.
- **`/privacy`, `/terms`, account deletion** — see "On the legal pages"
  below. Short version: accurate description of what this specific codebase
  does, backed by a real deletion feature, not just a document making a
  promise the code doesn't keep.

## On the legal pages — read this before you launch

`/privacy` and `/terms` are not filled-in boilerplate — they describe
exactly what this codebase collects and does, because I built it and know
precisely what that is (an email, article content, IP addresses retained for
90 days for anti-fraud purposes only, no ads, no third-party analytics, no
payment processor connected yet). The account-deletion flow
(`/dashboard/delete-account`) is a real feature, not just a policy promise —
it calls `supabase.auth.admin.deleteUser()`, which I verified cascades
correctly through `public.users` to a person's articles and views.

What this **can't** do is guarantee legal compliance in any jurisdiction.
That depends on facts only you have — where you're incorporated, where your
users actually are, whether you're handling real money yet — and general
frameworks (GDPR, India's DPDPA, US state laws like the CCPA) differ in ways
a generated document can't fully resolve. Both pages have `[bracketed
placeholders]` for things like governing law and a contact email that
specifically need a human (ideally a lawyer) to fill in before this is a
real, reliable Terms of Service — especially once Stripe payouts make the
revenue-share language load-bearing instead of aspirational.


## Notes / intentional scope choices

- Authors can delete only their own **drafts**; once submitted, an admin has
  to send it back first. Easy to loosen if you want authors to retract
  pending submissions themselves.
- `users.email` duplicates `auth.users.email` because the `auth` schema isn't
  queryable from the client — this is the standard Supabase pattern for
  joining "who wrote this" into article queries.
- A `display_name` column would be a natural next addition if you don't want
  raw emails as bylines.
- Package versions above reflect what was current as of this writing —
  double-check with `npm view <package> version` before deploying, especially
  given how fast Tailwind v4 and Tiptap v3 are still moving.

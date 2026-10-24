# Project Moon Combat Card Hub — Supabase-ready (Step 3)

This is the existing **V10** website (not a replacement game): front/back image uploads, flip and zoom, 5-card player decks, GM card vault and per-player unlocks, enemy types, battle actions + undo, emotion levels, round progression, unlimited enemy draws, and uploaded lobby music.

The backend now supports **Supabase database and private file storage** for hosting on Render. The original frontend files are intentionally unchanged.

## Keep your existing save safe first

From your existing V10 `pm-card-hub` folder, make a separate backup of:

- `data.json` — player profiles, unlocks, decks, battle state, enemy types.
- Entire `uploads/` folder — fronts, backs, lobby music.

Do **not** delete your working V10 installation. Do **not** upload `data.json`, `uploads`, `.env`, or credentials to GitHub.

## Step 3a — Local setup

1. Extract this ZIP into a **new** folder.
2. Copy your existing V10 `data.json` and `uploads/` into the **new** `pm-card-hub` folder. Keep the original files as backups.
3. Copy `.env.example` to a file named `.env` in the new folder.
4. In `.env`, set the values (no quotation marks needed):

   ```text
   ADMIN_PASSWORD=a-new-long-gm-password
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_SECRET_KEY=YOUR_SERVER_SIDE_SECRET
   SUPABASE_BUCKET=card-hub-media
   ```

   Find the URL in **Supabase Dashboard → Project Settings → API** (dashboard names can vary). Find the **server-side secret** in **Project Settings → API Keys**. Use a `sb_secret_...` key (or legacy `service_role` key if applicable), **not** the anon/publishable key. Never send these secrets to another person or commit `.env` to GitHub. You do *not* need to use the database password for this application.

5. Open Windows Command Prompt in the new `pm-card-hub` folder (File Explorer address bar → type `cmd` → Enter).
6. Run `npm install`.
7. Run `npm run migrate` to copy the existing referenced images/music and saved data to Supabase **once**.

   **If you haven't created any cards or saved data**, you may skip the migration; the empty Supabase row from Step 2 is already ready to use.

8. Run `npm start` and visit http://localhost:3000. The site should now be **reading/writing Supabase**, even locally. Stop any other server on port 3000 first (`Ctrl+C`).

**If migration refuses to overwrite existing Supabase data:** This is intentional. Check the existing online data instead of clearing it or overwriting it. The script uses exactly the `card_hub_state` table and private `card-hub-media` bucket from Step 2.

## Step 3b — Confirm your data

- Are both players' names still visible to the GM?
- Can they see their granted cards and saved decks?
- Can the GM see existing enemy types, draw enemy cards and end a round?
- Do card front/back images display and flip correctly?
- Does the existing lobby music play after a click?
- Restart the server and confirm progress still exists.

If yes, you are ready for **Step 4: put the code on GitHub and deploy to Render**.

## What changed under the hood

- `storage.js` reads/writes one Supabase `card_hub_state` row (id 1).
- Uploaded fronts, backs and music are stored in the private Supabase `card-hub-media` bucket.
- Existing `/uploads/...` addresses continue to work by redirecting to short-lived, signed Supabase URLs.
- Uploads use RAM before cloud storage; they do not rely on Render's temporary disk.
- `scripts/migrate.js` migrates the existing V10 `data.json` and its referenced files without changing card IDs.
- The API serializes requests on **one Node server instance** to avoid lost updates from two simultaneous users. Deploy as one Render instance.
- Production startup requires configured Supabase secrets and a non-default GM password.
- The old name-based player identity scheme is unchanged. This is **not secure login**; anyone who knows another player's exact name may be able to impersonate that player. Don't distribute your link beyond trusted players until per-player authentication is added.

**Additional limits:** Private bucket means the files themselves are not publicly listable, but media URLs returned to players are temporary bearer links; if someone already has a card's URL, they may view it until it expires. Free hosting services can sleep or pause, and free quotas can change. Keep local backups.

## Later: Render configuration

The bundled `render.yaml` provides the free web service settings. You can either use it as a Render Blueprint or create a normal Render Web Service manually:

- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- Plan: Free
- Environment variables: `NODE_ENV=production`, `ADMIN_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_BUCKET=card-hub-media`

Use **Render → Environment** to set actual secret values; never put them into `render.yaml`. Never commit the `.env` file.

To test local routes without any server dependency installation, run `node tests/supabase-ready.test.js`. Full hosted testing requires your own Supabase project credentials.

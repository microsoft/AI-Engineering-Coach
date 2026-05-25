# Team Mode Backend

This directory contains the lightweight Cloudflare Workers + D1 backend used by Team Mode.

## What it does

- Accepts only privacy-safe team snapshots from the extension
- Creates the first admin on bootstrap
- Issues one-time invite codes for team members
- Stores aggregate scores, counts, and trend data in D1
- Never stores raw prompts, code, file names, workspace names, or session text

## Deployment model

The backend is intentionally small:

- **Cloudflare Worker** exposes the HTTP API
- **D1** stores team metadata, invite state, tokens, and snapshot aggregates
- **Invite codes** are one-time and expire
- **Bearer tokens** identify admins and members

## First-time setup

1. Create a Cloudflare account and a D1 database.
2. Bind the D1 database to the Worker.
3. Deploy the Worker with the backend routes enabled.
4. Bootstrap the server by calling `POST /bootstrap` with the first admin payload.
5. Use the returned admin token to create invite codes for the rest of the team.

## Local development checklist

- Keep Team Mode off in the extension unless you are connected to a backend
- Verify that only aggregate analytics are emitted by the extension sync client
- Confirm that the backend rejects any payload containing raw text fields
- Confirm that admin-only routes reject non-admin bearer tokens

## Data policy

The backend stores only:

- category scores
- token usage totals
- anti-pattern counts and severity buckets
- week-over-week trend values

The backend does not store:

- raw prompts
- source code
- file names
- workspace names
- session transcripts


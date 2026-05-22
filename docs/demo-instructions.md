# Demo Instructions

Step-by-step guide for running a full SDLC Framework demo — from first boot to a live Teams notification.

---

## Prerequisites

- Node 22.x (`nvs use 22` or `nvm use 22`)
- Docker Desktop running
- A copy of `.sdlc-framework.config.json` (start from `.sdlc-framework.config.example.json`)

---

## 1. Start the stack

```powershell
npm run docker:up        # starts API server + Ollama in Docker
npm run dashboard        # starts Vite dev server (auto-detects port)
```

Or for local (non-Docker) development:

```powershell
npm run dev              # API server + dashboard in one terminal
```

---

## 2. Testing notifications locally

Before wiring up real Teams, use the included webhook spy to see every notification in your terminal.

**Start the spy in a separate terminal:**

```powershell
npm run notify:spy
# Teams webhook spy listening on http://localhost:3099
```

**Point the framework at it** — in `.sdlc-framework.config.json`:

```json
{
  "notifications": {
    "teams": {
      "webhookUrl": "http://localhost:3099"
    }
  }
}
```

Leave `NOTIFY_PROVIDER` unset (or set it to `teams`). Every `notify()` call — PR created, story assigned, review complete, build passed/failed — now prints to the spy terminal with color-coded emoji:

| Emoji | Color | Event type |
|-------|-------|------------|
| 🟣 | Indigo | Story assigned (immediate start) |
| 🟡 | Amber | Story assigned (awaiting approval) |
| 🟠 | Orange | PR created |
| 🟢 | Green | PR approved / build passed |
| 🔴 | Red | Changes requested / build failed |
| 🔵 | Cyan | DevOps build gate |
| 🩷 | Pink | UX design spec / design review |

**To suppress all notifications** (pure mock mode):

```
NOTIFY_PROVIDER=mock npm run server
```

---

## 3. Wiring up real Microsoft Teams

### Option A — Microsoft 365 Developer Tenant (free, recommended for full fidelity)

1. Enroll at **[developer.microsoft.com/microsoft-365/dev-program](https://developer.microsoft.com/microsoft-365/dev-program)**
2. Set up an **Instant Sandbox** — you get a free E5 tenant with 25 user licenses and full Teams
3. The tenant auto-renews every 90 days as long as you're actively using it for development
4. In Teams, go to a channel → **Connectors** → **Incoming Webhook** → configure → copy the URL

### Option B — Existing Teams org

Add an **Incoming Webhook** connector to any channel you own:

1. Channel → **···** → **Connectors** → search **Incoming Webhook** → **Add**
2. Name it (e.g. "SDLC Framework Dev") → **Create** → copy the URL

### Configure the webhook URL

In `.sdlc-framework.config.json`:

```json
{
  "notifications": {
    "teams": {
      "webhookUrl": "https://yourorg.webhook.office.com/webhookb2/..."
    }
  }
}
```

Remove the spy `webhookUrl` (or just shut down `npm run notify:spy`). All subsequent notifications go directly to Teams.

---

## 4. Run a demo story end-to-end

1. Open the dashboard → **Backlog** → pick a story (use `source: local` for a self-contained demo)
2. Assign it to the `frontend` agent → approve when prompted
3. Watch the Teams channel (or spy terminal) for:
   - 🟣 Story Assigned
   - 🟠 PR Created (after agent finishes coding)
   - 🟢 PR Approved (after reviewer agent runs)
   - 🔵 Build gate assigned to DevOps
   - 🟢 Build Passed

---

## 5. Provider switching quick reference

| Env var | Options | Default |
|---------|---------|---------|
| `PM_PROVIDER` | `agility`, `mock` | `agility` |
| `CR_PROVIDER` | `azure-devops`, `mock` | `azure-devops` |
| `NOTIFY_PROVIDER` | `teams`, `mock`, `none` | `teams` |

Set these in `.env` or pass them directly to the server process.

See [configuration.md](configuration.md) for the full config reference.

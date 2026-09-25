# MEMORY.md - Durable Facts and Decisions

Main-session load only. Curated, not a log — daily raw notes live in `memory/`.

## Homelab / pixerful.com exposure recipe

Last updated: 2026-09-24. Proven by viseca-shopper UI go-live.

<!-- project: github-swiss-ai-weeks/itsmaxjeffrey/swiss-ai-weeks -->

- Hosts: pve `192.168.1.100` (root ssh ok, Proxmox firewall config
  `/etc/pve/firewall/<vmid>.fw`, cluster `policy_in: DROP`); caddy LXC
  `192.168.1.109` (ssh alias `caddy`; Caddyfile `/etc/caddy/Caddyfile`, CF
  token `/etc/caddy/cloudflare.env`); dns box `192.168.1.105`; this VM = qemu
  101 = `192.168.1.103` (MAC bc:24:11:a1:26:58, **no root: no passwordless
  sudo, no root ssh key** — root work goes through the owner).
- DNS: Cloudflare, **wildcard `*.pixerful.com` → WAN 31.164.181.196**. New
  subdomain = zero DNS changes.
- To expose an app: (1) bind it `0.0.0.0`, (2) PVE rule in the guest's
  `<vmid>.fw` (`IN ACCEPT -source +dc/management -p tcp -dport <port>`),
  (3) guest ufw rule — **ufw is active on this VM and silently drops unknown
  ports**; owner runs `sudo ufw allow in on ens18 proto tcp from 192.168.1.109
  to any port <port> comment 'Caddy to <app>'`, (4) Caddy site block
  `reverse_proxy 192.168.1.103:<port>` + reload (validate with CF env sourced).
  TLS auto-issues via Cloudflare DNS-01.
- Firewall debugging: concurrent tcpdump on the pve host while a client curls —
  sequential capture gives false "0 packets". SYNs entering the guest tap with
  no SYN-ACK/RST back = guest-local (ufw) drop, not PVE.

## Deployment patterns

- Durable UI servers on this host: `setsid nohup env ... node server.js >>
  /tmp/<name>.log 2>&1 < /dev/null &` from the canonical repo path — never exec
  background:true (instances got reaped, Sep 23).
- GitHub pushes from this repo: deploy-key path (PAT is API-only, basic auth
  dead) — see workshop skill github-repo-publish.
- Big ingests must stream (2GB host at time of writing; free -h showed 9.2 GiB
  on Sep 24 — re-check before assuming).
- Shopper UI bridge (8794 → agent `viseca-shopper`, turn budget 590s): a turn
  that calls `ask_user` ALWAYS dies as a bridge timeout — webui customers can't
  see or answer structured questions, so the call blocks ~15 min past budget.
  Questions go out as plain chat text ending the turn (rule added to
  viseca-shopper AGENTS.md, Sep 24, after the 19:00 shoe-order timeout).
  <!-- project: github-swiss-ai-weeks/itsmaxjeffrey/swiss-ai-weeks -->
- Stopping a bridge turn (stop-v4, `846e321`, Sep 25): the bridge's direct
  `openclaw` child is only a LAUNCHER — the real CLI runs as an anchored
  grandchild in a supervisor-owned process group, so child.kill, group kills,
  and exitCode checks all miss it, and the gateway-side run orphans and keeps
  working. chat.abort / sessions.abort RPCs refuse cross-connection aborts of
  CLI-spawned runs ("unauthorized"); a "stop" chat message just queues a
  phantom turn. Working mechanism: each turn spawns the CLI with a unique
  VISECA_TURN_TOKEN env var; /api/chat/stop scans /proc/*/environ for the
  token and SIGKILLs every match — turn settles in seconds (live-verified).
  Also: turnWithRetry must skip its continuation retry when the customer
  stopped the turn (a stop-abort looks exactly like a no-reply failure).
  <!-- project: github-swiss-ai-weeks/itsmaxjeffrey/swiss-ai-weeks -->

# Meow translator — text ⇄ cat language

A two-way translator between English and a constructed cat language, plus a small
server that hosts it with an admin panel and a self-updating deployment.

**The app is real signal processing.** Typing English synthesises actual meows — a glottal
source, a three-formant filter cascade, pitch contours in semitones, a purr rumble, amplitude
envelopes — and recording a meow runs it back through segmentation, a 33-number acoustic
fingerprint per meow, and a classifier that recovers the words. The same codec is used in both
directions, which is what makes the round trip genuinely decodable rather than decorative.

```
text → token stream → synthesiser → audio → segmentation → features → classifier → text
```

- **Single-file app:** [`cat-translator.html`](cat-translator.html) — 531 kB, no network, no build step. Open it and it works.
- **Server:** `server/` — Node standard library only, zero npm dependencies.
- **Admin panel:** `/admin` — one-time registration, visit statistics with IP + location, credentials, updates with rollback.

---

## Quick start (server)

On a fresh Ubuntu box (20.04 / 22.04 / 24.04):

```bash
curl -fsSL https://raw.githubusercontent.com/mikeehendricks/Cat-Translator/main/install.sh | sudo bash
```

**The installer puts the app on port 80, reachable from outside.** Node.js, the service account, the
systemd unit (with the one capability port 80 needs) and the firewall are covered below. Two things
it cannot do for you: stop another web server that is already holding port 80 — it detects that and
refuses with instructions instead of installing a service that cannot start — and give you HTTPS.

or from a checkout:

```bash
git clone https://github.com/mikeehendricks/Cat-Translator.git
cd Cat-Translator
sudo ./install.sh
```

The installer prints the URL and a **one-time setup token**. Open `/admin`, paste the token,
create your account. That is the only time registration is open.

```bash
sudo ./install.sh --domain cat.example.com --email you@example.com   # with TLS
sudo ./install.sh --port 9000 --host 0.0.0.0                         # exposed directly
sudo ./install.sh --port 80 --host 0.0.0.0                           # the bare port 80
sudo ./install.sh --help                                            # all options
```

### Changing the port

```bash
sudo meow-translator config                        # show what it listens on now
sudo meow-translator config --port 8080            # change it and restart the service
sudo meow-translator config --port 80 --host 127.0.0.1   # port 80, but only from this machine
```

`config` edits `/etc/meow-translator/config.json`, keeps every other setting, refreshes the systemd
unit if the new port is privileged, and restarts. Re-running the installer with `--port` does the
same thing.

### Running on port 80 (or 443, or any port below 1024)

Port 80 is the default, and the service does **not** run as root, so it cannot bind a privileged
port on its own. The unit therefore grants exactly one capability:

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

That permission allows binding ports below 1024 and nothing else — no files, no other capabilities —
and it holds even with `NoNewPrivileges=true`, because systemd applies the ambient set before exec.
To change the port on an existing install, re-run the installer with the new value (it rewrites
`config.json` and the unit and restarts), or edit `/etc/meow-translator/config.json` and run
`sudo meow-translator install-service`. `sudo meow-translator doctor` checks that the unit grants
the capability whenever the configured port is below 1024.

Remember to open the port in your firewall (`sudo ufw allow 80/tcp`), and note that on plain HTTP
your admin password crosses the network in the clear — see *HTTPS* below. Both things are only
about exposure; the app itself is identical.

> **Microphone note:** browsers only allow audio capture in a secure context. Over plain HTTP the
> app still synthesises and plays meows, and the "read back the last meow" self-test still works —
> but recording needs HTTPS (or localhost, or an SSH tunnel). Use `--domain` and the installer will
> get a Let's Encrypt certificate.

---

## What the installer does

1. Installs Node.js 18+ (22 LTS from NodeSource, falling back to the distribution package).
2. Creates a dedicated **`meow` system account** — the service never runs as root.
3. Lays out three directories, so updates can never touch your data:

   | path | contents | replaced by updates |
   |---|---|---|
   | `/opt/meow-translator` | application code | yes |
   | `/var/lib/meow-translator` | store (visits, credentials, settings), version snapshots | **no** |
   | `/etc/meow-translator` | `config.json` (host, port, proxy trust) | **no** |

4. Installs and starts the systemd unit `meow-translator.service`:

   ```ini
   Restart=always          # load-bearing: the updater restarts the app by exiting cleanly
   User=meow
   ProtectSystem=strict    # plus PrivateTmp, NoNewPrivileges, and friends
   ReadWritePaths=/opt/meow-translator /var/lib/meow-translator
   ```

5. Optionally installs nginx + certbot in front (with `X-Forwarded-For`, so the visit log records
   real visitor addresses), and flips `trustProxy` on.
6. Prints the URL and the setup token.

Re-running the installer is safe and idempotent: it upgrades the code and the unit and leaves the
data directory alone.

---

## The admin panel (`/admin`)

**One-time registration.** The first visit offers a registration form that requires the setup
token printed by the installer (`sudo meow-translator token` prints or rotates it). Once an
account exists the form is gone for good and only login remains. Passwords are hashed with
scrypt (N=16384, r=8, p=1) and never stored in any recoverable form.

| tab | what it shows |
|---|---|
| **Overview** | app version + commit, latest version on GitHub, update status, visits today / 30 days / all time, unique visitors, distinct IPs, a 30-day sparkline, top countries and cities, recent visitors, server details (Node version, uptime, memory, store size), live sessions |
| **Visits** | every page view: timestamp, **IP address**, **location** (city, region, country, ISP), device, browser, path, referrer; filters by day / country / free-text; CSV export; delete-all |
| **Updates** | current version, remote version + commit + message, install button, rollback list, live update log, and a description of what an update does |
| **Credentials** | change username and/or password (current password required); signing out every session |
| **Settings** | privacy mode (store hashed addresses instead of raw IPs), location lookups on/off, retention days, automatic update checks, automatic install, repository, branch, GitHub token |
| **Audit log** | every admin action, login attempt and update, with IP and time |

The **version number is shown in three places**: the public app page footer, the admin panel
header, and the update tab — and the app page additionally tells visitors when a newer version
exists.

### Visit statistics

A visit is a page view of the translator itself (not admin traffic, not static assets). Location
comes from a public IP service — `ipwho.is` over HTTPS, falling back to `ip-api.com` — resolved
**after** the response is sent, cached for a month, and skipped entirely for private addresses
(which are labelled "Local network"). Two switches exist for operators who would rather not:

- **privacy mode** replaces the address with a salted SHA-256 hash of address + user agent. Unique
  and returning visitors are still counted; no address is stored.
- **location lookups off** keeps every address on your own server, at the cost of the location column.

Raw IPs are personal data under the GDPR and similar regimes. If that matters to you, turn privacy
mode on, set a retention window, and say so on the site.

---

## Updates

Updates come from this repository, and the panel shows both the running version and the newest
one. **Check now** resolves the branch to a commit; **install** applies it and restarts.

How it works, in order:

1. **Resolve and pin.** The branch tip is resolved to a commit sha, and that sha — not the branch —
   is installed. What gets smoke-tested is exactly what gets written, even if someone pushes meanwhile.
2. **Download.** `codeload.github.com/<repo>/tar.gz/<sha>`, refusing anything whose top-level
   directory does not carry that sha.
3. **Stage.** Unpacked into `/var/lib/meow-translator/staging`. The live tree is untouched.
4. **Smoke test.** `node server/selftest.js` runs *on the staged copy*: version parses, every server
   module compiles, the app page is present, self-contained and marked up, the admin page is intact,
   and a store + password round trip works in a temp directory.
5. **Snapshot.** The running tree is copied into `/var/lib/meow-translator/versions/<version>-<sha>/`
   and recorded in the store, so a rollback is always available — including back to the first install.
6. **Swap and restart.** Files are replaced, then the service exits cleanly and systemd's
   `Restart=always` brings it back on the new code (in a plain shell it re-executes itself instead).

**Rollback** picks a snapshot from the history, snapshots what is currently running, restores, and
restarts. Measured on a real installation: install ≈ 250 ms, restart ≈ 1.5 s.

Updates are **off by default** — the panel checks only when you press the button. Turn on
`autoCheckUpdates` for a check every six hours, and `autoInstallUpdates` if you want new versions
applied unattended (they are still smoke-tested first, and the previous version is still snapshotted).

**One honest limitation:** integrity rests on TLS plus the pinned commit. There is no signature,
because a public repository we do not hold release keys for cannot provide one. Treat this
repository as trusted code — if you fork it and point the updater at your own copy, use the token
setting for a private repo and think of it as "deploying from my own repo", because that is what it is.

---

## Publishing to GitHub

The repository is the update source, so pushing is how you release. The token must be able to
**write** to the repository:

| token type | what it needs |
|---|---|
| fine-grained (`github.com/settings/tokens?type=beta`) | Repository access: this repo · **Contents: Read and write** |
| classic (`github.com/settings/tokens`) | scope **`public_repo`** (this repo is public) or **`repo`** (private) |

A read-only token fails with `Resource not accessible by personal access token` (403) from the API,
or `Permission ... denied` from git. `tools/push-to-github.sh` checks for write access first and
tells you which one you hit:

```bash
GITHUB_TOKEN=<token with Contents: Read and write> ./tools/push-to-github.sh
```

It pushes `main` using a credential helper that reads the token from the environment, so the token
never lands in `.git/config`, in the process list, or in the shell history file.

The CI workflow lives at `deploy/github/ci.yml` rather than in `.github/`, because uploading a
workflow file needs an extra token permission (below); it is the same file, ready to copy into place:

```sh
mkdir -p .github/workflows && cp deploy/github/ci.yml .github/workflows/ci.yml
```

You can also add it through the GitHub web UI (*Add file → Create new file*, name it
`.github/workflows/ci.yml`). Everything it runs can be executed by hand meanwhile — see *Testing*.

Pushing `.github/workflows/` additionally needs the **Workflows: Read and write** permission
(fine-grained) or the **`workflow`** scope (classic). Without it GitHub refuses the whole push with
*"refusing to allow a Personal Access Token to create or update workflow"*. Add that permission and
push again, or leave the workflow file untracked and add it through the GitHub web UI.

**Releasing a new version** means: bump `VERSION`, commit, push. Installed servers then see it:

```bash
sudo meow-translator update --check     # or the Updates tab in /admin
```

Rebuild `cat-translator.html` (`node tools/build-app.mjs`) before bumping if you changed anything in
`src/` — CI fails the push if the committed bundle does not match its sources.

---

## Reaching it from another machine

`http://<the server's LAN address>/` should just work — the installer binds every interface. When it
does not, one command tells you which of the four usual reasons it is:

```bash
sudo meow-translator net-check
```

It reports, in plain language:

- whether **our** service is bound to all interfaces or only to `127.0.0.1` (in which case nothing
  outside the machine can connect), and names any *other* program that shares the port number on a
  different address;
- which addresses the machine actually has, flagging container/bridge interfaces (`docker0`, `br-*`,
  `veth*`) and link-local `169.254.x.x` addresses — neither is reachable from your laptop;
- whether the app answers on each of those addresses from the machine itself;
- whether `ufw` (or a `DROP` input policy) is blocking the port.

Read the last line of a failed connection attempt this way:

| from the other machine | meaning |
|---|---|
| `Connection refused` | something answered, and nothing is listening on that address — check the bind address |
| **times out / no route to host** | the packets never arrived — firewall, or the address is not really on your network |
| the browser pages you to **https://** | HTTPS-First upgrade. Type the `http://` form, or use `curl` to confirm the server is fine |

## Troubleshooting

| symptom | cause and fix |
|---|---|
| recordings don't work, "microphone unavailable" | browsers need a secure context. Serve over HTTPS (`sudo meow-translator setup-https your.domain.com`) or use localhost. |
| every visitor is logged as `127.0.0.1` | the app is behind a proxy but `trustProxy` is false. Set it in `/etc/meow-translator/config.json` (or let `setup-https` do it) and restart. |
| can't reach it from another machine on the LAN | `sudo meow-translator net-check` — it checks the bind address, which program owns the port, whether the address is a LAN address at all (not a container bridge or a link-local one), and whether ufw allows the port, then prints the fix. |
| changing the port to 80 leaves the service dead | the unit needs `CAP_NET_BIND_SERVICE` (above). `sudo meow-translator install-service` rewrites it from the deployed template. |
| visitor addresses look forged | the app is exposed directly but `trustProxy` is true, so a client can send its own `X-Forwarded-For`. Set `"trustProxy": false` when nothing sits in front of the app. |
| location column stays "looking up…" | outbound HTTPS is blocked, or lookups are off. Check with `sudo meow-translator geo-probe` and the Settings tab. |
| update check fails with "VERSION not found" | the repository is not a valid update source yet — `VERSION` must exist at the root of the branch you follow. |
| update check fails with "rate limit reached" | set a GitHub token in Settings (it also lets a private fork be used). |
| service won't start after an update | `sudo meow-translator rollback` restores the previous version; `journalctl -u meow-translator -n 50` shows why. |
| service stopped and never came back | the unit needs `Restart=always` for the updater's exit-and-return restart. `sudo meow-translator install-service` rewrites it from the deployed template. |
| forgot the admin password | `sudo meow-translator reset-password` (also signs out every session). |
| forgot the setup token | `sudo meow-translator token` prints it; `--rotate` mints a new one. |
| anything looks broken | `sudo meow-translator doctor` — ownership, store readability, the unit and disk space; `--fix` repairs what it can. |
| "registration is closed" and you want a fresh install | `sudo meow-translator reset-password` claims the account directly, or remove the store with `sudo rm /var/lib/meow-translator/store.json` and restart (this deletes visits too). |

Logs: `journalctl -u meow-translator -f` · Data: `/var/lib/meow-translator` · Backups:
`sudo meow-translator backup`.

---

## The command line

```bash
sudo meow-translator status                 # version, service state, URL, visit count
sudo meow-translator config [--port N] [--host ADDR]   # what it listens on, and how to change it
sudo meow-translator net-check              # why can't another machine reach it?
sudo meow-translator token [--rotate]       # print or rotate the one-time setup token
sudo meow-translator update [--check|--sha <commit>]
sudo meow-translator versions               # installed history with snapshots
sudo meow-translator rollback [version]     # roll back one version (or to a specific one)
sudo meow-translator backup --out /root/meow-$(date +%F).tar.gz
sudo meow-translator reset-password [user]  # also re-opens nothing: registration stays closed
sudo meow-translator install-service        # refresh the systemd unit after an update
sudo meow-translator setup-https cat.example.com --email you@example.com
sudo meow-translator logs -n 100
sudo meow-translator geo-probe              # is the location provider reachable?
sudo meow-translator doctor [--fix]         # check ownership, readability, the unit, free space
```

Uninstall:

```bash
sudo ./uninstall.sh            # removes the code and service, keeps data
sudo ./uninstall.sh --purge    # removes data and configuration too
```

---

## How the cat language works

A meow is a token — `onset-vowel-tone-length`:

| part | values | acoustically |
|---|---|---|
| onset | `m`, `prr` (trilled), `h` (breathy), `none`, `chirp` | voiced onset, purr-modulated, noise-led, vowel-initial, sharp call |
| vowel | `a e i o u y` | F1/F2/F3 of a three-formant cascade |
| tone | `flat rise fall arch dip` | a real pitch contour in semitones (fall = +7 → −8 st) |
| length | `short normal long` | duration and envelope |

Plus four specials (`purr`, `hiss`, `chirp`, `chatter`). Numbers are counted out as repeats of the
counting meow. A sentence is a sequence of meows separated by short gaps.

The codebook was chosen, not invented: the generator renders all 364 possible meows, measures each
one, and keeps the ~115 that sit farthest apart in that acoustic space — while holding each meaning's
tone and length to its original hand-written meow (falling = no/bad, rising = question/urgency).

**Recognition:** resample to a canonical 22.05 kHz → energy segmentation into individual meows →
33 features per meow (pitch contour, range, duration, voicing, harmonicity, spectral flatness, purr
and trill detectors, 16 log-spaced bands on a pitch-normalised axis) → compared against fingerprints
rendered by the synthesiser itself, each meow treated as a small Gaussian (its own mean and spread
per dimension) → tokens → English.

## Measured accuracy

Every figure comes from a script in `tools/`; none are hand-written.

| evaluation | per-meow top-1 | top-3 | word | whole utterance |
|---|---|---|---|---|
| its own audio (self-test) | 97.6 % | 100 % | 97.4 % | 94.3 % |
| fresh meows, careful mic | 91.7 % | 97.8 % | 90.9 % | 80.7 % |
| harsh (loud noise, muffled mic) | 66.5 % | 79.8 % | 66.4 % | 45.0 % |

Adding one condition at a time (`tools/cliff.mjs`, whole phrases): identical to a reference call
99 %, new voice or speed 100 %, quiet level 100 %, light hiss 100 %, muffled microphone 99 %,
48 kHz capture 98 %, 16 kHz capture 66 % (a 16 kHz recording genuinely has no top octave).

A single meow carries about four bits, so the app shows four candidates and lets you tap the one you
meant, which re-decodes the sentence immediately. Under loud noise with a muffled microphone accuracy
drops to about two thirds of meows — that is what the candidates are for.

Acceptance tests:

```bash
node tools/roundtrip.mjs        # text → synth → recogniser → text: 31/31 phrases, 68/68 meows
node tools/verify-bundle.mjs    # the same, through the shipped single file: 18/18
```

## Tests

```bash
node tools/test-server.mjs                       # 76 checks: install, auth, visits, updates, rollback
node tools/test-ui.mjs                           # 71 checks: the app's UI and the interface guidelines
node tools/test-installed.mjs http://127.0.0.1:8899   # verify a running installation over HTTP
node server/selftest.js                          # the smoke test the updater runs
```

`test-ownership.mjs` (run as root: `sudo node tools/test-ownership.mjs`, or the CI step) builds an
installation owned by a *different* account, drives a root-run CLI command and a real update plus
rollback against a stand-in GitHub, and asserts the service account can still read everything
afterwards. It exists because that bug shipped once.

`test-server.mjs` stands up a throwaway installation, a stand-in GitHub (a local HTTP server serving
a tarball of the tree with the version bumped), and drives the real flows: one-time registration,
CSRF and cross-origin refusals, visit logging with location, a real update *including the restart
handshake*, a rollback, a deliberately broken download that must not touch the live tree, credential
changes, login lockout, and privacy mode.

## The interface

Both pages are built on one design system, `design/ui.css`, following Apple's Human Interface
Guidelines. It is plain CSS with no build step of its own:

- **Text styles** named after the platform's — `.large-title`, `.title1`–`.title3`, `.headline`,
  `.body`, `.callout`, `.subhead`, `.footnote`, `.caption`, `.caption2` (11pt, the platform minimum).
  The stack asks for the system font (SF on Apple platforms) and falls back sensibly elsewhere.
- **Semantic colour.** Nothing in either page names a literal colour: `--label`, `--label-2`,
  `--separator`, `--fill-3`, `--tint` (systemBlue) and the rest each carry their own light, dark and
  Increase Contrast values. Change `--tint` and the whole product follows.
- **Materials.** The top bar is translucent chrome (`backdrop-filter: saturate() blur()`), with an
  opaque fallback when blur is unsupported and when Reduce Transparency is on.
- **Layout by size class.** One column on compact widths and two above 56rem, a 16pt standard margin,
  `env(safe-area-inset-*)` respected, and 44pt minimum hit targets on everything tappable.
- **Accessibility.** Reduce Motion, Reduce Transparency and Increase Contrast are all honoured;
  focus rings are visible, every control has an accessible name, state changes are announced
  (`aria-live`) and never signalled by colour alone.
- **Icons** come from `design/symbols.html`, a 23-symbol inline sprite on a 24×24 grid with a 1.9
  stroke. No emoji, no icon font, nothing fetched.

The app inlines the design system and the sprite at build time (`tools/build-app.mjs`), so
`cat-translator.html` stays a single file that renders with no network at all. The admin panel keeps
two placeholders and is composed the same way when it is first served, so it also arrives in one
request.

`tools/test-ui.mjs` asserts the parts of this that can be checked mechanically — the text-style
hierarchy, both appearances, contrast, reduced motion, hit sizes, focus, accessible names, described
canvases, and that no symbol reference dangles. It is the reason a future redesign cannot quietly
drop dark mode or the 44pt targets.

## Repository layout

```
cat-translator.html      the built single-file app (what / serves)
VERSION                  the version the updater compares against
install.sh uninstall.sh  Ubuntu installer / remover
bin/meow-translator      server-side control tool
server/
  server.js              HTTP server, routes, visit capture
  admin.html             the admin panel (single file, no dependencies)
  selftest.js            the smoke test an update must pass
  lib/                   config, store, auth, geo, stats, updater, restart
deploy/                  systemd unit template
src/                     app sources (lexicon, tokens, engine, synth, match, app, shell)
design/                  the shared design system (ui.css) and the icon sprite (symbols.html)
tools/                   codebook generator, tuner, evaluator, tests, dev servers
audio/                   example meows rendered by the synthesiser
```

## Rebuilding the app

`src/*.js` are DOM-free-at-load IIFEs (they load in both a browser and Node's `vm`), and
`src/shell.html` is the page.

```bash
node tools/make-lexicon.mjs     # regenerate the codebook (slow; then rebuild templates + weights)
node tools/build-templates.mjs  # render reference fingerprints (~40 s)
REBUILD=1 node --max-old-space-size=4096 tools/tune.mjs   # optimise feature weights (~4 min)
N=300 node tools/eval.mjs       # three-profile accuracy run → tools/metrics.json
node tools/build-app.mjs        # bundle everything into cat-translator.html
```

Order matters: `make-lexicon` → `build-templates` → `tune` → `eval` → `build-app`. The fingerprints
and the tuned weights must come from the same build, or the recogniser reads stale references.

## Honest limitations

- Real cats have no words. This is a constructed language you can hear: a codec whose speaker and
  listener were designed together. Your cat is reacting to pitch, rhythm and attention — which, to be
  fair, is most of what it ever wanted anyway.
- One meow carries four bits. Top-1 on a single meow is ~92 % in good conditions, not 100 %.
- The update system trusts this repository (TLS + pinned commit, no signature).
- The visit log stores personal data unless privacy mode is on.

MIT licensed — see [LICENSE](LICENSE).

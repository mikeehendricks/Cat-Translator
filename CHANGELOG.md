# Changelog

## 1.0.15

- **The Settings tab renders again.** 1.0.14's note about where a proxy-trust choice is kept
  referred to a variable that does not exist in that function (`sv`, which the Overview tab uses),
  so rendering the tab threw and left the operator looking at a blank screen. The API answered 200,
  every server-side check passed, and nothing in the log said a word.
- **An empty table now explains itself.** The Visits tab hides bot traffic by default — crawler
  hits, monitors, `curl`, headless browsers — while the summary counts everything, so a fresh
  installation that has only been scanned showed "0 visits" above a table with nothing in it. That
  state now says how many views are hidden and offers one tap to show them; a search that matches
  nothing says that instead, and offers to clear the filters.
- **`tools/test-panel.mjs` (32 checks) drives the panel the way an operator does.** It starts its
  own installation, signs in through the panel's own form in jsdom, opens every tab, and reads what
  is rendered: the visit rows with their provenance, the all-bot empty state, the filtered empty
  state, the three-way proxy-trust control saving through to the store, and no tab rendering empty.
  An API test cannot see a blank screen — this one can.

## 1.0.14

- **A proxy-trust choice made in the panel is now actually kept.** 1.0.13 wrote it to
  `/etc/meow-translator/config.json`, which looks right and is not: the shipped systemd unit runs the
  service with `ProtectSystem=strict` and that file is deliberately root-owned, so the write failed
  (silently, as a warning) and the choice reverted on the next restart — while the panel went on
  showing the chosen value until then. It is now stored with the other settings in the data
  directory, which is the part of an installation the service owns, and applied at start-up over
  whatever the config file says. The config remains the installer's default; the Settings tab says
  which file that is and where the choice is kept.

## 1.0.13

- **The visit log now shows the visitor's own address, and says how it knows.** A server can see the
  socket and any forwarding headers, and nothing else; behind a router or a container network the
  address it sees belongs to the middlebox. So the address is now resolved with its provenance, and
  the panel shows which case a row is:
  - **Forwarding headers** (`CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`, `X-Forwarded-For`,
    `Forwarded`, Vercel, Fastly) are believed only when the request arrived from something trusted.
    `trustProxy` defaults to `auto`: headers are honoured for a loopback or private-network peer — a
    proxy on this machine or the LAN — and ignored for a direct connection from the internet, which
    is what stops a visitor from writing their own address. `on` trusts them from anywhere, `off`
    ignores them; the Settings tab writes the choice to `config.json`.
  - **A private address is never geolocated.** Asking a provider about `192.168.1.5` returns that
    provider's guess about a network that is not on the internet. The visit is marked private
    instead, and the location column waits for a real address.
  - **When the address we can see is private, the browser is asked.** The page is served with a
    one-time `meow_visit` nonce (HttpOnly, `SameSite=Lax`, 15 minutes) and asks a public service what
    address the world sees it from, then reports it to `POST /api/visit/ip`. The server accepts it
    once, for that nonce only, and only for a real routable public address — private, loopback,
    link-local, multicast and documentation ranges are refused. The row then carries the reported
    address, its location, and what the server saw first beside it.
  - Both halves have switches: the report on/off (`reportVisitorIp`, forced off in privacy mode) and
    the lookup endpoints (`publicIpEndpoints`, for running your own). With the report off the page
    asks nobody. Day-level unique counts follow the corrected address, so one visitor behind a router
    counts once, not once per middlebox address.
  - `tools/test-server.mjs` covers it: header trust with and without a local proxy, CIDR ranges, the
    private/public split, report validation, nonce single-use and expiry, and the panel's switch
    writing through to the config file (126 checks, from 83).

- **The Translate button no longer has a way to look dead.** It does work — but if anything inside
  the click handler throws, the browser keeps the exception to itself and the button simply appears
  broken. The concrete case was `new AudioContext()`: on a browser or webview without Web Audio that
  throws, and because it was the first thing the handler did, not even the meow text appeared. Now:
  - **Audio is optional.** Synthesis never needed a context; when there is none the samples are still
    produced (standalone `AudioBuffer`, or the waveform and text alone), and the page says which part
    is missing rather than going quiet.
  - **Translate plays the meow**, with the chips highlighting as it progresses — the button now does
    the thing it is named after, instead of only producing text.
  - **Every handler reports failure.** A throw is caught by a guard, shown in a strip at the top of
    the page with a one-tap "Copy details", and included in `MEOW_APP.diagnostics()` along with the
    user agent, the Web Audio status and a test encode.
  - **Empty or unknown input says so**: a hint under the buttons rather than a card that looks like a
    result.
  - `tools/test-ui.mjs` now boots the page twice — once with Web Audio and once without — and asserts
    that the button still translates, explains itself and throws nothing (92 checks, from 71).

## 1.0.12

- **The installer fetches its unpacking reader from two independent sources.** It takes
  `server/lib/archive.js` from `raw.githubusercontent.com` (a CDN, which once served a cached miss for
  a file that had just been added — and a cached miss would send the install straight back to the tar
  that may be the reason for installing) and, if that fails, from the GitHub API, which caches
  separately and works for a private fork when a token was supplied. A response that is not the file
  (a JSON error page saved as `archive.js`) is discarded rather than run.

## 1.0.11

- **A root command that has to create the data directory now gives it to the service account.**
  Ownership was preserved by matching the neighbour — right for a file written into an existing
  directory, useless when the directory is the thing being created. If the data directory was gone
  (deleted, or a fresh machine) and the first thing run was `sudo meow-translator …`, the directory
  and its store came out owned by root, and the service then failed to start with `EACCES` on its own
  store — which reads like the visits and credentials have vanished. The account is now looked for
  directly when there is nothing to match: an explicit name, the application directory (the installer
  gives it to the service), or the config file, which is deliberately root-owned and group-readable
  by the service. `updater.ensureDir()` uses the same rule for `versions/` and `staging/`.
  `tools/test-ownership.mjs` now runs a root command against a missing data directory and asserts the
  result belongs to the service account and is readable by it (36 checks, from 32).

## 1.0.11

- **The updater no longer needs `tar`.** On some hosts the system tar cannot create files at all:
  every entry comes back `tar: <path>: Cannot open: Function not implemented`, which is `open(2)`
  returning `ENOSYS` — what a seccomp profile, a user namespace or an unusual filesystem does to a
  syscall it does not implement. The archive had already been downloaded and written to disk by Node
  in that same directory, so it was tar's child process being refused, not the filesystem. Installing
  an update on such a machine failed with a message that named tar and nothing else.
  `server/lib/archive.js` now does the unpacking with the standard library — gzip via `zlib`, tar
  parsed directly — and `tar` is kept only as a second attempt for archives that use something the
  reader does not know about. If both fail, the error names the filesystem the staging directory is
  on, so the next report of this kind is diagnosable in one line. The update log says which method
  was used.
- **`install.sh` works on those hosts too.** Staging the payload and copying it into place used
  `tar` as well, which made a broken tar a broken installer. Both now use the same reader when it can
  be had (it is a single file: taken from the source tree, or fetched from the same branch in
  remote installs) and only fall back to `tar` when it cannot be. This also means the fix can be
  delivered to a machine whose updater is already broken, which is the case that matters.
- **Unpacking is now a security boundary too.** Entries are checked individually: an absolute path,
  a `..` segment or a symlink pointing outside the archive is refused rather than half-applied, and
  symlinks and hard links that stay inside the tree are recreated while links that leave it are
  reported and skipped. Writing it ourselves is what made that checkable.
- New suite `tools/test-archive.mjs` (32 checks) compares the reader against GNU tar byte for byte —
  both the GNU and POSIX formats, long paths needing a long-name record, a 3 MB file, symlinks,
  permission bits — proves unpacking works with no tar on `PATH`, and proves the hostile archives
  above are refused. `tools/test-server.mjs` now runs the *entire* suite with a tar that always
  fails, so every update and rollback in it is exercised on a machine like the one that reported
  this: 83 checks, and a check that tar was never called once.

## 1.0.9

- **The interface now follows Apple's Human Interface Guidelines.** Both the app and the admin panel
  are rebuilt on one shared design system (`design/ui.css`): the platform's text styles from Large
  Title down to Caption 2, semantic colours that carry their own light, dark and Increase Contrast
  values, a translucent chrome bar with a `saturate()`+`blur()` material (and an opaque fallback
  where blur is unsupported), a grouped-background layout with cards, and 44pt minimum hit targets
  with a visible focus ring. Reduce Motion, Reduce Transparency and Increase Contrast are all
  honoured; nothing is signalled by colour alone.
- **The app page was reorganised for size classes, not for devices.** One column with a segmented
  "English → Meow / Meow → English" control on compact widths; two panes side by side above 56rem,
  where the control steps aside. A large title scrolls under the bar and a small title fades in. Each
  pane has an empty state before first use, the long explanation moved into a proper sheet (a
  `<dialog>`, with an inline fallback where `<dialog>` is missing), and the version and update notice
  stay where they were.
- **The admin panel uses the same system**, so the two pages finally look like one product: grouped
  cards, a sticky chrome header, badges for version/update/who, and a segmented section control. It
  is composed with the design system and the symbol sprite inlined at first request, so the panel
  still renders in one request and still works on a machine with no way out to the network.
- **Icons are drawn, not borrowed.** `design/symbols.html` is a 23-symbol inline sprite (24×24 grid,
  1.9 stroke, `currentColor`); emoji are gone from the interface chrome, so nothing depends on a font
  the machine may not have. Every button that changed state now says so in words as well as colour —
  copying reports "Copied", recording changes shape and wording.
- **Behaviour is unchanged and still enforced by the suites.** Every id the app exposes is preserved;
  the UI test now also asserts the parts of the guidelines that can be checked mechanically (text
  styles, semantic colours, dark mode, contrast, reduced motion/transparency, hit sizes, focus,
  accessible names, described canvases, radio-group semantics, no external references). 71 checks in
  `tools/test-ui.mjs`, 76 in `tools/test-server.mjs`, 18 in `tools/verify-bundle.mjs`.
- Fixed while doing it: the record button's state class was applied backwards (the "recording" style
  showed at rest), and an empty translation no longer renders a card that says "0 meows" — the empty
  state stays until there is something to say.
- **`install.sh --local` no longer copies the world.** A development checkout can hold a repository,
  installed dependencies, caches and a data directory; `cp -a` of the tree staged all of it, and if
  that data directory sat inside the tree the copy fed itself back in until the disk filled (it did,
  during this release: 3 GB in seconds). The payload is now assembled with the same exclusions the
  rsync path already had, plus the resolved data directory wherever it lives, and the installer
  refuses a payload over 256 MB with a message saying what probably got in.

## 1.0.8

- **New command: `meow-translator net-check`** — "why can't another machine reach it?". It reports
  whether our own service is bound to all interfaces or only loopback, names any other program
  holding the same port number, flags addresses that are not LAN addresses at all (container
  bridges, link-local `169.254.x.x`), tests the app from the machine itself on each address, and
  checks `ufw`/`DROP` policies — then prints the command that fixes it. It judges its own sockets by
  reading `/proc/<pid>/cmdline`, so a proxy or port-forward on the same port number cannot be
  mistaken for the service.
- Documented how to read a failed connection: connection refused means nothing is listening on that
  address; a timeout means a firewall or a wrong address; a browser upgrade to HTTPS is its own case.

## 1.0.7

- **Port 80 is the default.** `sudo ./install.sh` (or `curl … | sudo bash`) now installs on port 80,
  reachable from outside, instead of 8787 on localhost only. `server/lib/config.js` defaults match,
  so a bare `node server/server.js` agrees with the installer.
- **New command: `meow-translator config [--port N] [--host ADDR]`.** Changes the address, keeps the
  other settings, refreshes the unit when the new port is privileged, and restarts the service — no
  need to re-run the installer just to move a port.
- **The installer refuses to fight another web server for the port.** If something other than this
  app is already listening, it names the process and stops before changing anything, instead of
  installing a service that cannot bind. If the port is already served by this app, it says so and
  reinstalls over it.
- A bind failure now explains itself: `EACCES` prints the two ways out (the unit's capability, or a
  high port for development), and `EADDRINUSE` points at `ss` and `meow-translator config`.
- The installer says, plainly, what an exposed plain-HTTP port means: open the firewall, the admin
  password crosses the network unencrypted until you add HTTPS, and the microphone needs HTTPS.
- Fixed a silent failure in the installer's port check: closing a file descriptor it never opened
  (`exec 3<&-`) made the script exit with no message at all, because a failing `exec` redirection
  ends a non-interactive shell.

## 1.0.6

- **The service can run on a privileged port.** `sudo ./install.sh --port 80 --host 0.0.0.0` now
  works: the systemd unit grants `CAP_NET_BIND_SERVICE` (and its bounding set) so the unprivileged
  service can bind ports below 1024, without running as root and without weakening
  `NoNewPrivileges`.
- `doctor` checks that the unit grants that capability whenever the configured port is below 1024,
  and `--fix` rewrites the unit from the deployed template.
- Documented: changing the port on an existing install, the firewall, and why `trustProxy` should be
  false when nothing sits in front of the app.

## 1.0.5

- **The updates list marks the right row as running.** It used to mark the newest snapshot, which is
  the *pre-update* state — the version you would roll back to — and, because several snapshots can
  share a version number, it could mark several rows at once. A row is now marked only if it is the
  snapshot that was actually restored, or its commit is the one running.
- The server test picks a free port and refuses to start if one is already answering, after a
  crashed run left a server behind and the next run talked to that stale process instead of its own.

## 1.0.4

- **An undeletable old snapshot no longer aborts an update.** The service can only prune snapshots
  it owns; one left behind by another account (a root-run update on an older release) made the
  whole update fail with `EACCES` while removing `versions/…`. It now keeps the snapshot, reports
  exactly which one and why, and finishes the update.
- `doctor` now looks **inside** the application, data and snapshot trees, not just at the top-level
  entries — stray ownership was hiding in there, invisible to the old check. `--fix` repairs it.
- CLI-driven updates are written to the store's update log, so they appear in the `/admin` panel's
  update history exactly like updates started from the panel. Previously the CLI logged to the
  terminal only, and its warnings vanished when the process exited.
- Update and rollback warnings are returned to the panel and printed by the CLI instead of being
  swallowed.
- The CI workflow ships as `deploy/github/ci.yml`. It cannot live at
  `.github/workflows/ci.yml` in this repository until the access token carries the *Workflows: Read
  and write* permission (or the classic `workflow` scope) — GitHub refuses any push that touches a
  workflow file without it. Copy it into place once that permission is granted. Until then the
  scripts it runs can be executed by hand; see the README.

## 1.0.3

- **Regression test for the ownership bug** (`tools/test-ownership.mjs`, run as root, plus a CI
  step): it builds an installation owned by a different account, drives a root-run CLI command and
  a real update plus rollback against a stand-in GitHub, and asserts the service account can still
  read everything.
- Snapshot and staging directories now inherit the data directory's owner, including the first time
  a root-run command creates them.
- `meow-translator update` and `rollback` honour `restartMode: "off"` instead of restarting anyway,
  and accept `--flag=value` as well as `--flag value`.
- `doctor --skip-unit-check`, for hosts that do not run the systemd unit.

## 1.0.2

Fixes a bug that could take the service down after a command-line update.

- **Ownership is preserved when root runs the tooling.** `sudo meow-translator update`
  wrote the store and the application tree as root, which left the data directory unreadable
  to the unprivileged service account — the service then failed to start and its error looked
  like the visit log and credentials had vanished. Every root-run write path now hands the
  result back to the account that owns the surrounding directory, before and after a swap.
- **`meow-translator doctor`** checks the installation (ownership of the app, data, store and
  snapshot directories, store readability, `Restart=always` in the unit, free space) and
  `--fix` repairs what it can.
- Store permission errors now name the directory to chown and the service to restart, and are
  never treated as a corrupt file.

## 1.0.1

- `meow-translator update --check` now names the case instead of guessing: identical commit,
  newer version, same version with a different commit (a redeploy), or an older remote.
- Adds release notes, so the Update tab has something to point at besides the commit message.

## 1.0.0

First release.

- **The translator.** Text is synthesised into cat calls — glottal source, three-formant cascade,
  pitch contours in semitones, purr rumble, amplitude envelopes — and recordings are read back
  through energy segmentation, a 33-feature acoustic fingerprint per meow, and a per-class Gaussian
  classifier. Both directions share one codec, so the round trip is decodable.
  Measured 97.6 % top-1 on its own audio, 91.7 % on fresh voices, 66.5 % under noise and a muffled
  microphone; text → meow → text is exact for 31/31 test phrases.
- **Server.** Node standard library only, no npm dependencies.
- **Install.** `install.sh` for Ubuntu: Node.js, a dedicated `meow` system account, a systemd unit
  with `Restart=always`, optional nginx and Let's Encrypt.
- **Admin panel** at `/admin`: one-time registration behind a setup token, scrypt credentials,
  server-side sessions with CSRF and same-origin checks, login lockout, audit log, credential
  changes, on-demand restart.
- **Visit statistics**: IP address, location (asynchronous, cached, skippable), device, browser,
  referrer, CSV export, retention window, and a privacy mode that keeps only a salted hash.
- **Updates**: resolves the branch to a commit, refuses an archive that does not carry that sha,
  stages it, smoke-tests the staged copy, snapshots the running tree, swaps, restarts. Rollback
  restores any snapshot. Versions are shown on the app page, in the panel and in the CLI.
- **Tests**: 70 server checks including a real update-and-rollback round trip with the restart
  handshake, a jsdom UI test of the app, and an HTTP verification script for an installed instance.

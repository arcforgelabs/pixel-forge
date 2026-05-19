# Linux VM Release Gate

Pixel Forge Linux release proof should run inside the shared `local-vm-lab`
Ubuntu UI test guest instead of the operator's active desktop. The guest gives
Electron, CDP, and screenshot automation a stable display while keeping host
clicks and window focus out of the test lane.

## VM

The VM is owned by `~/repos/local-vm-lab`, not by Pixel Forge:

```bash
cd ~/repos/local-vm-lab
scripts/ubuntu-ui-test.sh create
scripts/ubuntu-ui-test.sh wait
scripts/ubuntu-ui-test.sh snapshot clean
```

The manager uses the local Ubuntu 24.04 cloud image when present:

```text
~/repos/local-vm-lab/images/ubuntu-24.04-cloudimg-amd64.img
```

It creates an `ubuntu-ui-test` libvirt VM on the default NAT network with:

- SSH user `tester`.
- QEMU Guest Agent.
- Node 22, pnpm 10.25.0, Python, Go 1.24.
- GNOME/GDM on the visible VM console for human inspection.
- Xvfb on `:99`, Openbox, x11vnc/noVNC tooling, and Electron runtime libs
  for script-driven GUI tests.
- Repo sync target `/opt/workspaces/<repo-name>`.

The current validated baseline is `ubuntu-ui-test` on `192.168.122.97` with a
`clean` libvirt snapshot created on May 19, 2026.

## Commands

```bash
~/repos/local-vm-lab/scripts/ubuntu-ui-test.sh ip
~/repos/local-vm-lab/scripts/ubuntu-ui-test.sh ssh
~/repos/local-vm-lab/scripts/ubuntu-ui-test.sh sync ~/repos/pixel-forge
scripts/vm/linux-ui-vm-smoke.sh
~/repos/local-vm-lab/scripts/ubuntu-ui-test.sh snapshots
~/repos/local-vm-lab/scripts/ubuntu-ui-test.sh revert clean
```

`smoke` syncs the current repo into the guest and runs:

```bash
bash scripts/vm/run-linux-release-smoke.sh
```

## Release Meaning

Host-level `pnpm verify` stays useful for fast development. The VM lane is the
Linux public-release gate. A Linux release is not considered proven until the VM
can run the installed GUI smoke without relying on the host desktop.

The VM lane should grow to cover:

- Fresh npm one-line install.
- Installed app icon and desktop launcher.
- Settings runtime identity and CalVer.
- Update check/stage/apply behavior.
- Direct Codex provider GUI send/reload.
- Optional Agent Deck provider GUI send using Codex underneath.
- Failure screenshots and logs copied back to `state/vm/pixel-forge-linux-ci/exports/`.

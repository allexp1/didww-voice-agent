#!/usr/bin/env bash
# Host hardening: SSH key-only, fail2ban, sysctl RTP tuning,
# unattended-upgrades. Idempotent. Run as root.
set -euo pipefail

echo "[harden] SSH key-only drop-in"
install -d -m 0755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
# didww-voice-agent host hardening — managed, do not hand-edit.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
EOF
# cloud-init ships a drop-in that re-enables password auth, and (first-match-
# wins) it sorts before ours — neutralise it in place.
if [ -f /etc/ssh/sshd_config.d/50-cloud-init.conf ]; then
  sed -i 's/^[[:space:]]*PasswordAuthentication.*/PasswordAuthentication no/' \
    /etc/ssh/sshd_config.d/50-cloud-init.conf
fi
sshd -t
systemctl reload ssh
echo "[harden] sshd config valid + reloaded"

echo "[harden] fail2ban sshd jail"
cat >/etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
maxretry = 4
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban

echo "[harden] sysctl RTP tuning"
sysctl --system >/dev/null
echo "  net.core.rmem_max = $(sysctl -n net.core.rmem_max)"

echo "[harden] unattended-upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades || true
systemctl enable --now unattended-upgrades || true

echo "[harden] DONE"

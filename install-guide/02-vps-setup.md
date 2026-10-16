# 02 — VPS Setup

Create the server and give it a secure baseline. (~15 minutes, mostly waiting.)

---

## 1. Create the VPS

From your provider's panel (see the matrix in
[01-prerequisites.md](01-prerequisites.md)):

- **Image:** Ubuntu 24.04 LTS (22.04 also fine)
- **Plan:** per the sizing table — smallest is fine to start
- **Region:** closest to your hotels/guests
- Note the **IPv4 address** it prints — you'll need it for DNS and SSH

---

## 2. First SSH login

**Contabo / Truehost:** the root password arrives by email (or in the panel).

```bash
ssh root@YOUR_VPS_IP        # paste the emailed password at the prompt
```

**Cloud providers:** you created an SSH key at order time:

```bash
ssh -i ~/.ssh/your_key root@YOUR_VPS_IP
```

### Install your own SSH key (do this immediately — password login ends here)

On **your laptop**:

```bash
cat ~/.ssh/id_ed25519.pub        # no key? → ssh-keygen -t ed25519 -N ''
ssh-copy-id root@YOUR_VPS_IP     # enter the password one last time
ssh root@YOUR_VPS_IP             # must now log in WITHOUT a password
```

`ssh-copy-id` unavailable (Windows without it)? Append manually on the server:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'PASTE_YOUR_PUBLIC_KEY_HERE' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

> **Contabo/Truehost note:** after adding the key, disable password SSH only
> if you're comfortable with key-only access — it's the safer setup:
> `sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl reload sshd`

---

## 3. OS baseline (paste all, takes ~2 minutes)

Run **on the VPS**. This is the "OS baseline" from OPERATIONS.md — the install
script does NOT do these for you:

```bash
apt-get update && apt-get upgrade -y

# 1) Automatic security updates
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# 2) 2 GB swap file (insurance for small plans during login bursts)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 3) Time sync (certs and logs depend on correct time)
apt-get install -y chrony && systemctl enable --now chrony

# 4) Basic tools the deploy kit uses
apt-get install -y git curl ufw
```

Sanity check:

```bash
free -h | grep Swap      # should show 2Gi
timedatectl              # NTP synchronized: yes
```

---

## 4. Firewall

The install script (`deploy/setup-vps.sh`) opens **22/80/443** via ufw
automatically. If you want it done now instead:

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
ufw status
```

If your provider has an **additional** cloud firewall panel (DO/Hetzner/Vultr
network firewalls, GCP VPC rules, Truehost panel), allow **22, 80, 443** there
too — a VPS can have two firewalls stacked.

> Email note: many providers (Contabo, Truehost especially) block **outbound
> port 25**. Irrelevant here — StayChat sends mail through APIs over port 443.

---

## 5. (Optional but recommended) Hostname + non-root user

```bash
hostnamectl set-hostname staychatos
# optional: create an admin user instead of living as root
adduser deploy && usermod -aG sudo deploy
# copy your SSH key for the new user, then test: ssh deploy@YOUR_VPS_IP
```

The rest of this guide uses `root` for simplicity — every command works as a
`sudo` user too (prefix `sudo` where noted by apt).

---

## Checkpoint ✓

- [ ] `ssh root@YOUR_VPS_IP` logs in with your key, no password
- [ ] `free -h` shows 2G swap
- [ ] `ufw status` allows 22/80/443 (or provider firewall does)
- [ ] You know your VPS IPv4 → next step needs it

---

## Next → [03-dns-cloudflare.md](03-dns-cloudflare.md)

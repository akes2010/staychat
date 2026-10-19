#!/usr/bin/env node
// scripts/setup-env.js — first-run environment setup for a fresh installation.
// The Desk PC Edition installer (install.sh / install.bat) calls this after
// `npm install`; running it again by hand later is always safe.
//
// What it does, in order:
//   1. copies .env.example → .env when .env doesn't exist yet
//   2. on that freshly-created file, fills every secret with a fresh random
//      value (never prints the values — only which keys were generated)
//   3. on that same fresh file, switches NODE_ENV to development — see below.
//
// AN EXISTING .env IS NEVER MODIFIED. It only reports placeholder/missing
// secrets with instructions — rotating CREDENTIALS_ENCRYPTION_KEY under a
// live database would make already-encrypted credentials unreadable, so key
// changes on an existing install are always the operator's explicit action.
//
// Why development on a desk PC: production mode marks the auth cookies
// `Secure`, and browsers reject Secure cookies on plain-HTTP LAN addresses
// (http://192.168.x.x:3000) — sign-in would silently never stick. The secrets
// are generated either way, so tokens are never signed with the public
// development defaults. Behind a TLS proxy you can set NODE_ENV=production.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

// key → bytes of randomness (rendered as hex). CREDENTIALS_ENCRYPTION_KEY
// encrypts saved third-party credentials at rest — a placeholder there would
// mean predictable encryption on the customer's own machine.
const SECRETS = {
  JWT_ACCESS_SECRET: 48,
  JWT_REFRESH_SECRET: 48,
  COOKIE_SECRET: 32,
  CREDENTIALS_ENCRYPTION_KEY: 32,
};

// True when a value is missing, empty, or still the template's placeholder
// text ("generate_a_48_byte_random_string_here", "<generate_unique…>", …).
function isPlaceholder(value) {
  if (value == null) return true;
  const v = String(value).trim();
  if (!v) return true;
  if (/^(generate|<|a_different|another_)/i.test(v)) return true;
  if (/_here$|string_here|random_string/i.test(v)) return true;
  return v.length < 32; // a real secret is never shorter than this
}

function setLine(text, key, value) {
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(text)) return text.replace(re, key + '=' + value);
  return text.replace(/\s*$/, '\n') + key + '=' + value + '\n';
}

function main() {
  const existed = fs.existsSync(ENV_PATH);

  // ── Existing install: observe, never touch ────────────────────────────────
  if (existed) {
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    const weak = Object.keys(SECRETS).filter((key) => {
      const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
      return !m || isPlaceholder(m[1]);
    });
    if (weak.length) {
      console.log('! .env already exists — left untouched. These secrets are missing or still');
      console.log('  template placeholders: ' + weak.join(', '));
      console.log('  Rotate them manually if this install should not use placeholder keys.');
      console.log('  NOTE: changing CREDENTIALS_ENCRYPTION_KEY makes credentials already');
      console.log('  encrypted with the old key unreadable — re-encrypt them first.');
    } else {
      console.log('✔ .env already exists and looks configured — nothing to change');
    }
    return;
  }

  // ── Fresh install: create from the template and fill every secret ────────
  if (!fs.existsSync(EXAMPLE_PATH)) {
    console.error('✗ .env.example not found next to this script — cannot create .env.');
    process.exit(1);
  }
  let text = fs.readFileSync(EXAMPLE_PATH, 'utf8');

  const filled = [];
  for (const [key, bytes] of Object.entries(SECRETS)) {
    const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
    if (!m || isPlaceholder(m[1])) {
      text = setLine(text, key, crypto.randomBytes(bytes).toString('hex'));
      filled.push(key);
    }
  }

  // LAN-safe cookie behaviour (fresh file only — an existing .env belongs to
  // the operator, whatever mode they chose).
  let modeNote = '';
  if (/^NODE_ENV=production\s*$/m.test(text)) {
    text = text.replace(
      /^NODE_ENV=production\s*$/m,
      '# Desk PC Edition default: plain-HTTP LAN sign-in needs non-Secure cookies.\n' +
      '# Set NODE_ENV=production only when serving this install behind HTTPS.\n' +
      'NODE_ENV=development'
    );
    modeNote = ' (NODE_ENV=development for plain-HTTP LAN sign-in; use production behind HTTPS)';
  }

  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  console.log('✔ Created .env from .env.example' + modeNote);
  if (filled.length) console.log('✔ Generated strong random secrets: ' + filled.join(', '));
}

main();

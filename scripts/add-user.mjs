#!/usr/bin/env node
/**
 * 生成一个用户的 SQL，直接跑进 D1。
 *
 *   node scripts/add-user.mjs <用户名> <显示名> [口令]
 *
 * 不给口令就随机生成一个 12 位的。口令只在这里出现一次，存进库的是
 * PBKDF2-SHA256(210000 轮) 的哈希，服务端拿不到明文。
 */
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 不要往上调。Cloudflare Workers 的 WebCrypto 硬性拒绝超过 100000 的迭代次数
//    （NotSupportedError: iteration counts above 100000 are not supported）。
//    本地 wrangler dev 不强制这条，所以调高了只有线上登录会 500，很难查。
const ITERATIONS = 100000;
const crypto = webcrypto;

const [, , usernameRaw, displayNameRaw, passwordRaw] = process.argv;

if (!usernameRaw) {
  console.error('用法：node scripts/add-user.mjs <用户名> <显示名> [口令]');
  process.exit(1);
}

const username = usernameRaw.trim().toLowerCase();
const displayName = (displayNameRaw || usernameRaw).trim();
const password = passwordRaw || randomPassword();

const hash = await hashPassword(password);
const sql =
  `INSERT INTO users (username, display_name, password_hash) VALUES ` +
  `('${esc(username)}', '${esc(displayName)}', '${hash}') ` +
  `ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash;`;

console.log('');
console.log('  用户名：' + username);
console.log('  显示名：' + displayName);
console.log('  口  令：' + password + (passwordRaw ? '' : '   ← 随机生成，记下来'));
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const target = (await rl.question('写入哪个库？[1] 本地  [2] 线上  [3] 只打印 SQL  (默认 1) ')).trim() || '1';
rl.close();

if (target === '3') {
  console.log('\n' + sql + '\n');
  process.exit(0);
}

const flag = target === '2' ? '--remote' : '--local';
console.log(`\n正在写入 ${flag === '--remote' ? '线上' : '本地'} 数据库…`);

// ⚠️ 走临时文件而不是 --command：Windows 上 shell:true 会按空格拆参数，
//    带空格的 SQL 会被 wrangler 当成一堆未知参数。
const sqlFile = join(tmpdir(), `add-user-${Date.now()}.sql`);
writeFileSync(sqlFile, sql + '\n', 'utf8');
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'stocks-record', flag, '--file', sqlFile, '-y'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log('完成。');
} finally {
  rmSync(sqlFile, { force: true });
}

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return ['pbkdf2', ITERATIONS, b64url(salt), b64url(new Uint8Array(bits))].join('$');
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomPassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function esc(s) {
  return s.replace(/'/g, "''");
}

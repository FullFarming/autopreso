#!/usr/bin/env node
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(projectRoot, 'webapp', '.env.local');
const vercelPath = join(projectRoot, 'webapp', '.env.admin-vercel');

async function readPassword(prompt) {
  if (!process.stdin.isTTY) throw new Error('비밀번호를 숨겨 입력할 수 있는 터미널에서 실행해 주세요.');
  process.stderr.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolvePassword, reject) => {
    let password = '';
    const finish = (error) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolvePassword(password);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('설정을 취소했습니다.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { password = [...password].slice(0, -1).join(''); return; }
      if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f]/u.test(text)) password += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

function writePrivateFile(target, value) {
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('설정 파일은 일반 파일이어야 합니다.');
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

try {
  const password = await readPassword('관리자 비밀번호: ');
  const confirmation = await readPassword('비밀번호 확인: ');
  if (password !== confirmation) throw new Error('비밀번호가 일치하지 않습니다.');
  if (password.length < 10 || password.length > 256) throw new Error('비밀번호는 10~256자로 입력해 주세요.');
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const hash = `scrypt-v1$${salt.toString('hex')}$${key.toString('hex')}`;
  if (existsSync(envPath) && !lstatSync(envPath).isFile()) throw new Error('설정 파일은 일반 파일이어야 합니다.');
  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const preserved = current.split(/\r?\n/u).filter((line) => !/^\s*(?:export\s+)?ADMIN_(?:USER_IDS|PASSWORD|PASSWORD_HASH)\s*=/u.test(line)).join('\n').trimEnd();
  const localHash = hash.replaceAll('$', '\\$');
  writePrivateFile(envPath, `${preserved}\nADMIN_USER_IDS=noel\nADMIN_PASSWORD_HASH=${localHash}\n`);
  // 2026-09-05 fix: Next.js dotenv expands dollar signs; Vercel's dashboard expects the unescaped hash.
  writePrivateFile(vercelPath, `ADMIN_USER_IDS=noel\nADMIN_PASSWORD_HASH=${hash}\n`);
  process.stdout.write('관리자 로그인 해시를 로컬 비공개 설정에 저장했습니다. Vercel 입력용 값: webapp/.env.admin-vercel\n');
  if (!/^ADMIN_BOOTSTRAP_EMAILS=.+/mu.test(current)) process.stdout.write('추가 설정 필요: ADMIN_BOOTSTRAP_EMAILS에 실제 관리자 이메일을 지정해 주세요.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : '설정에 실패했습니다.'}\n`);
  process.exitCode = 1;
}

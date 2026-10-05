/**
 * SepoliaのSera APIキーを発行し、SERA_API_KEY / SERA_API_SECRETを.envへ保存する。
 * ManageApiKeyをローカルで署名するだけなので、RPC・ガス代・テストJPYCは不要。
 * シークレットは発行時に一度しか返らないため、.env更新前に非公開の控えも保存する。
 */

import { Wallet } from "ethers";
import { randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { savePrivate } from "./execute.js";
import { envValue, fail, isMain } from "./index.js";
import { address, CHAIN_ID, parseConfig, record, sameAddress, Sera } from "./sera.js";

export const MANAGE_API_KEY_TYPES = {
  ManageApiKey: [
    { name: "owner", type: "address" },
    { name: "action", type: "string" },
    { name: "timestamp", type: "uint256" },
  ],
};
export interface Credentials {
  api_key: string;
  api_secret: string;
}

/** 
 * 応答全体や認証情報をログへ渡さず、必要な2項目だけを検査する。
 */
export function credentials(value: unknown): Credentials {
  const r = record(value);
  for (const name of ["api_key", "api_secret"] as const) {
    const v = r[name];
    if (typeof v !== "string" || !v.length || v.length > 512 || /[\s:\p{Control}]/u.test(v))
      throw new Error("invalid_api_key_response");
  }
  return { api_key: r.api_key as string, api_secret: r.api_secret as string };
}

/** 
 * 既存設定を残し、空欄のSeraキーだけを更新する。取得済みの値は上書きしない。
 */
export function envContents(original: string, key: Credentials): string {
  const before = parseEnv(original);
  if (before.SERA_API_KEY || before.SERA_API_SECRET) throw new Error("sera_key_already_configured");
  const retained = original
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?SERA_API_(?:KEY|SECRET)\s*=/.test(line))
    .join("\n");
  const result = `${retained}${retained.endsWith("\n") ? "" : "\n"}SERA_API_KEY=${JSON.stringify(key.api_key)}\nSERA_API_SECRET=${JSON.stringify(key.api_secret)}\n`;
  const after = parseEnv(result);
  // 引用符や複数行の設定があっても、Nodeが読み込む値を変えないことを確認する。
  if (
    after.SERA_API_KEY !== key.api_key ||
    after.SERA_API_SECRET !== key.api_secret ||
    Object.entries(before).some(
      ([name, value]) =>
        !["SERA_API_KEY", "SERA_API_SECRET"].includes(name) && after[name] !== value,
    )
  )
    throw new Error("unsupported_env_format");
  return result;
}

/** 
 * .envを途中まで書き換えないよう、一時ファイルを0600で保存してから置き換える。
 */
export async function replaceEnv(file: string, contents: string): Promise<void> {
  const temporary = `${file}.sera-key-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/**
 * Sera Protocol用のAPIキーを発行するメソッド
 * @param env 
 * @param file 
 * @param sera 
 * @param persistEnv 
 * @returns 
 */
export async function createSeraApiKey(
  env: NodeJS.ProcessEnv,
  file = resolve(".env"),
  sera = new Sera(),
  persistEnv = replaceEnv,
) {
  const owner = address(envValue(env, "WALLET_ADDRESS"));
  const wallet = new Wallet(envValue(env, "TESTNET_PRIVATE_KEY"));
  if (!sameAddress(wallet.address, owner)) throw new Error("wallet_mismatch");
  if (env.SERA_API_KEY?.trim() || env.SERA_API_SECRET?.trim())
    throw new Error("sera_key_already_configured");
  // .envの実ファイルだけを更新し、リンク先への意図しない書き込みを避ける。
  if (!(await lstat(file)).isFile()) throw new Error("invalid_env_file");
  const original = await readFile(file, "utf8");
  envContents(original, { api_key: "preflight", api_secret: "preflight" });

  const dir = resolve(dirname(file), "runs/private");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = resolve(dir, "sera-api-key-create.lock");
  let handle: FileHandle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch {
    throw new Error("api_key_creation_locked");
  }
  try {
    // テストネット設定のdomainとサーバー時刻を使い、端末の時刻ずれを避ける。
    const config = parseConfig(await sera.request("/config"));
    const clock = await sera.clock();
    const timestamp = Math.floor(clock.now());
    const message = { owner, action: "create", timestamp };
    const signature = await wallet.signTypedData(config.domain, MANAGE_API_KEY_TYPES, message);

    // 発行POSTは1回だけ。応答を失っても自動で再発行しない。
    const result = await sera.request("/api-keys", {
      owner_address: owner,
      action: message.action,
      timestamp,
      signature,
      label: "jev-sera-sample",
    });
    const key = credentials(result);
    const backup = resolve(dir, `sera-api-key-${randomUUID()}.json`);
    await savePrivate(backup, { owner_address: owner, chain_id: CHAIN_ID, ...key });

    try {
      // API呼び出し中に利用者が.envを編集していたら、変更を上書きしない。
      if ((await readFile(file, "utf8")) !== original) throw new Error("env_changed");
      await persistEnv(file, envContents(original, key));
    } catch {
      // キーは非公開の控えに残っている。値ではなく保存先だけを案内する。
      return {
        status: "saved_to_backup",
        chain_id: CHAIN_ID,
        owner,
        backup_file: backup,
        reason: "env_update_failed",
      };
    }
    return { status: "saved", chain_id: CHAIN_ID, owner, env_file: file, backup_file: backup };
  } finally {
    await handle.close();
    await unlink(lock);
  }
}

if (isMain(import.meta.url)) {
  createSeraApiKey(process.env)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "saved") process.exitCode = 1;
    })
    .catch(fail);
}

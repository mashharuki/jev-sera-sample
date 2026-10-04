import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { TypedDataEncoder, verifyTypedData, Wallet } from "ethers";
import {
  createSeraApiKey,
  credentials,
  envContents,
  MANAGE_API_KEY_TYPES,
} from "../src/create-sera-api-key.js";
import { API_BASE, CHAIN_ID, Sera } from "../src/sera.js";

// 公開されたダミー鍵だけで検証する。外部APIのキー発行やガス消費は行わない。
const privateKey = `0x${"22".repeat(32)}`;
const owner = new Wallet(privateKey).address;
const env = { WALLET_ADDRESS: owner, TESTNET_PRIVATE_KEY: privateKey };
const issued = { api_key: "offline_key_123", api_secret: "offline_secret_456" };
const original = '# テスト用設定\nTYPESAFE_API_KEY="offline"\nSERA_API_KEY=\nSERA_API_SECRET=\n';
const domain = {
  name: "Sera",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: "0x83475A1bD98a8DC2DCd507A747e4DC85da241D6e",
};
const config = {
  chain_id: CHAIN_ID,
  sera_address: domain.verifyingContract,
  sor_address: "0x83c1368110B640A729f3810De5FBe94b99aa5668",
  eip712_domain: domain,
  domain_separator: TypedDataEncoder.hashDomain(domain),
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sera-key-test-"));
  const file = join(dir, ".env");
  await writeFile(file, original);
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function transport(
  post: (init: RequestInit | undefined) => Promise<Response>,
  paths: string[] = [],
  chain = CHAIN_ID,
): typeof fetch {
  return async (url, init) => {
    const path = String(url).slice(API_BASE.length);
    paths.push(path);
    if (path === "/config") return Response.json({ ...config, chain_id: chain });
    if (path === "/system/time") return Response.json({ timestamp: 1_700_000_000 });
    assert.equal(path, "/api-keys");
    return post(init);
  };
}

test("key creation signs the correct action/domain and privately saves both credentials", async () => {
  const f = await fixture(),
    paths: string[] = [];
  try {
    const sera = new Sera(
      transport(async (init) => {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(init?.body as string);
        assert.equal(body.owner_address, owner);
        assert.equal(body.action, "create");
        assert.equal(body.timestamp, 1_700_000_000);
        assert.equal(
          verifyTypedData(
            domain,
            MANAGE_API_KEY_TYPES,
            { owner, action: body.action, timestamp: body.timestamp },
            body.signature,
          ),
          owner,
        );
        return Response.json(issued);
      }, paths),
    );
    const result = await createSeraApiKey(env, f.file, sera);
    assert.equal(result.status, "saved");
    assert.deepEqual(paths, ["/config", "/system/time", "/api-keys"]);
    const stored = parseEnv(await readFile(f.file, "utf8"));
    assert.equal(stored.SERA_API_KEY, issued.api_key);
    assert.equal(stored.SERA_API_SECRET, issued.api_secret);
    assert.equal(stored.TYPESAFE_API_KEY, "offline");
    const backup = JSON.parse(await readFile(result.backup_file, "utf8"));
    assert.equal(backup.api_secret, issued.api_secret);
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal((await stat(result.backup_file)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(result).includes(issued.api_key), false);
    assert.equal(JSON.stringify(result).includes(issued.api_secret), false);
  } finally {
    await f.cleanup();
  }
});

test("existing credentials and wallet mismatch stop before network calls", async () => {
  const f = await fixture();
  let calls = 0;
  const sera = new Sera(async () => {
    calls++;
    throw new Error("unexpected_network");
  });
  try {
    await assert.rejects(
      createSeraApiKey({ ...env, SERA_API_SECRET: "existing" }, f.file, sera),
      /already_configured/,
    );
    await assert.rejects(
      createSeraApiKey({ ...env, WALLET_ADDRESS: domain.verifyingContract }, f.file, sera),
      /wallet_mismatch/,
    );
    await writeFile(f.file, `${original}SERA_API_KEY="existing"\n`);
    await assert.rejects(createSeraApiKey(env, f.file, sera), /already_configured/);
    assert.equal(calls, 0);
  } finally {
    await f.cleanup();
  }
});

test("wrong chain and existing creation lock prevent key issuance", async () => {
  const f = await fixture(),
    paths: string[] = [];
  try {
    const sera = new Sera(transport(async () => Response.json(issued), paths, 1));
    await assert.rejects(createSeraApiKey(env, f.file, sera), /wrong_chain/);
    assert.deepEqual(paths, ["/config"]);
    await mkdir(join(f.dir, "runs/private"), { recursive: true });
    await writeFile(join(f.dir, "runs/private/sera-api-key-create.lock"), "");
    await assert.rejects(createSeraApiKey(env, f.file, sera), /creation_locked/);
    assert.equal(paths.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("env update failure keeps the issued secret in a private backup", async () => {
  const f = await fixture();
  try {
    const result = await createSeraApiKey(
      env,
      f.file,
      new Sera(transport(async () => Response.json(issued))),
      async () => {
        throw new Error("simulated_write_failure");
      },
    );
    assert.equal(result.status, "saved_to_backup");
    assert.equal(await readFile(f.file, "utf8"), original);
    assert.equal(
      JSON.parse(await readFile(result.backup_file, "utf8")).api_secret,
      issued.api_secret,
    );
    assert.equal(JSON.stringify(result).includes(issued.api_secret), false);
  } finally {
    await f.cleanup();
  }
});

test("an env edit during creation is preserved; lost creation responses are not retried", async () => {
  const f = await fixture();
  try {
    const changed = `${original}OTHER_SETTING=changed\n`;
    const result = await createSeraApiKey(
      env,
      f.file,
      new Sera(
        transport(async () => {
          await writeFile(f.file, changed);
          return Response.json(issued);
        }),
      ),
    );
    assert.equal(result.status, "saved_to_backup");
    assert.equal(await readFile(f.file, "utf8"), changed);
    let posts = 0;
    await assert.rejects(
      createSeraApiKey(
        env,
        f.file,
        new Sera(
          transport(async () => {
            posts++;
            throw new Error("lost_response_secret_must_not_print");
          }),
        ),
      ),
      (error) => error instanceof Error && error.message === "sera_transport_failed",
    );
    assert.equal(posts, 1);
  } finally {
    await f.cleanup();
  }
});

test("credential and dotenv validation reject empty/control data and preserve other settings", () => {
  assert.throws(() => credentials({ api_key: "", api_secret: "secret" }));
  assert.throws(() => credentials({ api_key: "key", api_secret: "secret\ninjected=value" }));
  const updated = envContents(
    'OTHER="line one\nline two"\nSERA_API_KEY=\nSERA_API_SECRET=\n',
    issued,
  );
  assert.equal(parseEnv(updated).OTHER, "line one\nline two");
  assert.throws(
    () => envContents('OTHER="line one\nSERA_API_KEY=inside\nline two"\n', issued),
    /unsupported_env_format/,
  );
});

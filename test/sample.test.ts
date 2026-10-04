import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TypedDataEncoder, verifyTypedData, Wallet } from "ethers";
import {
  INTENT_TYPES,
  PERMIT_TYPES,
  permitPayload,
  poll,
  signedBody,
  submitSaved,
} from "../src/execute.js";
import { options, prepare, report, select } from "../src/index.js";
import { classify, type Decision, MODEL, validateDecision } from "../src/jev.js";
import {
  API_BASE,
  address,
  amountRaw,
  type Candidate,
  CHAIN_ID,
  type Config,
  parseConfig,
  parseTokens,
  Sera,
  summary,
  type Token,
  uint,
  validateQuote,
} from "../src/sera.js";

/**
 * HTTPをモック化し、外部API・課金・実送信なしで正常系と見送り条件を検証する。
 * 署名テストもローカルで生成・復元するだけで、Swapや送金は行わない。
 */
// 以下はオフライン署名テスト専用の公開されたダミー鍵。このウォレットに資金を送らない。
const wallet = new Wallet(`0x${"11".repeat(32)}`);
const owner = wallet.address;
const input: Token = {
  symbol: "JPYC",
  address: address("0x0b2dfe45ca948a5f75e358e4000ed0adf1142150"),
  decimals: 6,
  min: 0n,
};
const usdc: Token = {
  symbol: "USDC",
  address: address("0x965d4b4546716e416e950bc30467d128455d2d0e"),
  decimals: 6,
  min: 0n,
};
const usdt: Token = {
  symbol: "USDT",
  address: address("0x8365421d0e1b316fc6398d21be162992216bf2ad"),
  decimals: 6,
  min: 0n,
};
const config: Config = {
  sor: address("0x83c1368110B640A729f3810De5FBe94b99aa5668"),
  domain: {
    name: "Sera",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: address("0x83475A1bD98a8DC2DCd507A747e4DC85da241D6e"),
  },
};
const configWire = {
  chain_id: CHAIN_ID,
  sera_address: config.domain.verifyingContract,
  sor_address: config.sor,
  eip712_domain: config.domain,
  domain_separator: TypedDataEncoder.hashDomain(config.domain),
};
const registry = {
  tokens: [input, usdc, usdt].map((t) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
    currency: t.symbol === "JPYC" ? "JPY" : "USD",
    min_trade_amount_raw: "0",
  })),
};
// 固定の時刻と金額で、ライブ価格や実時間に依存しないテストにする。
const clock = { now: () => 1000 };
const budget = 10_000_000_000n;
function decision(policy: Decision["policy"] = "best_quote", confidence = 0.95): Decision {
  return {
    policy,
    confidence,
    model: MODEL,
    probabilities: { best_quote: 0.95, prefer_usdc: 0.02, prefer_usdt: 0.02, wait: 0.01 },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
function jevResponse() {
  const d = decision();
  return {
    model: d.model,
    usage: d.usage,
    answers: {
      policy: {
        type: "choice",
        choice: d.policy as string,
        confidence: d.confidence,
        probabilities: d.probabilities,
      },
    },
  };
}
function quote(token = usdc, amount = "63059999", expiration = 1600) {
  const domain = {
    name: "JPYC Inc.",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: input.address,
  };
  return {
    uuid: "00000000-0000-4000-8000-000000000001",
    expires_at: 1030,
    route_params: {
      taker: owner,
      inputToken: input.address,
      outputToken: token.address,
      maxInputAmount: budget.toString(),
      minOutputAmount: amount,
      recipient: owner,
      initialDepositAmount: budget.toString(),
      uuid: "42",
      deadline: expiration,
    },
    permit: {
      permit_supported: true,
      permit_required: true,
      token: input.address,
      owner,
      spender: config.sor,
      value_raw: budget.toString(),
      nonce: 0,
      domain,
      eip712: {
        domain,
        primaryType: "Permit",
        types: PERMIT_TYPES,
        message: {
          owner,
          spender: config.sor,
          value: budget.toString(),
          nonce: 0,
          deadline: expiration,
        },
      },
    },
  };
}
// 存在を型だけで断定せず、テスト中もassertで確認してから使う。
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
const candidate = (token = usdc, amount = "63059999"): Candidate => ({
  token,
  quote: quote(token, amount),
  reason: null,
});
function batchTransport(items: unknown[], calls: string[] = []): typeof fetch {
  return async (url) => {
    calls.push(String(url));
    return Response.json({ items });
  };
}

// Jevの実推論ではなく、SDKへの入力形式と返答の実行時検査を確認する。
test("Jev SDK sends pinned model and four typed choices", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const result = await classify(
    "Choose the best quote.",
    ["USDC", "USDT"],
    "offline-test",
    async (url, init) => {
      calls.push({ url, body: JSON.parse(required(init).body as string) });
      return Response.json(jevResponse());
    },
  );
  assert.equal(result.policy, "best_quote");
  assert.equal(calls.length, 1);
  assert.equal(required(calls[0]).url, "https://api.typesafe.ai/v1/systemone");
  const body = required(calls[0]).body as {
    model: string;
    questions: { policy: { type: string; choices: unknown } };
  };
  assert.equal(body.model, MODEL);
  assert.equal(body.questions.policy.type, "choice");
});
test("Jev rejects unknown labels, non-finite confidence, missing probabilities and wrong model", () => {
  for (const change of [
    (r: ReturnType<typeof jevResponse>) => {
      r.answers.policy.choice = "invented";
    },
    (r: ReturnType<typeof jevResponse>) => {
      r.answers.policy.confidence = NaN;
    },
    (r: ReturnType<typeof jevResponse>) => {
      r.answers.policy.confidence = 1.1;
    },
    (r: ReturnType<typeof jevResponse>) => {
      delete (r.answers.policy.probabilities as Partial<Decision["probabilities"]>).wait;
    },
    (r: ReturnType<typeof jevResponse>) => {
      r.model = "unverified-model";
    },
  ]) {
    const r = jevResponse();
    change(r);
    assert.throws(() => validateDecision(r), /invalid_jev_response/);
  }
  const rounded = jevResponse();
  rounded.answers.policy.probabilities.wait = 0.010001;
  assert.equal(validateDecision(rounded).policy, "best_quote");
});
test("SDK authentication error does not expose response secrets", async () => {
  await assert.rejects(
    classify("request", ["USDC"], "offline-test", async () =>
      Response.json({ error: "secret-must-not-appear" }, { status: 401 }),
    ),
    (e) => e instanceof Error && e.message === "jev_request_failed",
  );
});
// 金額・候補選択: 大きな整数、桁数の違い、許可外・一部失敗での見送りを確認する。
test("amount parsing rejects rounding, scientific notation, zero and uint overflow", () => {
  assert.equal(amountRaw("10000", 6), budget);
  assert.equal(amountRaw("9007199254740993.123456", 6), 9007199254740993123456n);
  for (const value of [
    "0",
    "0.0",
    "-1",
    "1e4",
    "1,000",
    "01",
    "1.0000000",
    "1.0000001",
    (2n ** 256n).toString(),
  ])
    assert.throws(() => amountRaw(value, 6));
  assert.throws(() => uint(Number.MAX_SAFE_INTEGER + 1));
});
test("CLI constraints reject unknown/duplicate destinations and missing execution minimum", () => {
  const args = ["--amount", "10000", "--request", "Compare received amounts."];
  assert.deepEqual(options([...args, "--allow", "USDC,USDT"]).allow, ["USDC", "USDT"]);
  for (const allow of ["USDC,USDC", "DAI", "", "USDC, USDT"])
    assert.throws(() => options([...args, "--allow", allow]));
  assert.throws(() => options([...args, "--allow", "USDC"], true), /min_output/);
  assert.throws(() => options(["--status", "--trade-id", "../bad"], true));
});
test("config must be Sepolia and have a consistent Sera signing domain", async () => {
  assert.deepEqual(parseConfig(configWire), config);
  for (const change of [
    { chain_id: 1 },
    { domain_separator: "0x00" },
    { eip712_domain: { ...config.domain, verifyingContract: config.sor } },
  ])
    assert.throws(() => parseConfig({ ...configWire, ...change }));
  const paths: string[] = [];
  const sera = new Sera(async (url) => {
    paths.push(String(url));
    return Response.json({ ...configWire, chain_id: 1 });
  });
  await assert.rejects(sera.initialize(["USDC"]), /wrong_chain/);
  assert.deepEqual(paths, [`${API_BASE}/config`]);
});
test("registry rejects ambiguous symbols, wrong currency and decimals", () => {
  assert.equal(required(parseTokens(registry, ["JPYC"])[0]).decimals, 6);
  assert.throws(() => parseTokens({ tokens: [...registry.tokens, registry.tokens[0]] }, ["JPYC"]));
  assert.throws(() =>
    parseTokens({ tokens: [{ ...registry.tokens[0], decimals: 100 }] }, ["JPYC"]),
  );
  assert.throws(() =>
    parseTokens({ tokens: [{ ...registry.tokens[0], currency: "USD" }] }, ["JPYC"]),
  );
});
test("quotes bind token, owner, recipient, budget, positive output and both deadlines", () => {
  assert.equal(
    validateQuote(quote(), input, usdc, owner, budget, 1600, clock).route_params.minOutputAmount,
    "63059999",
  );
  for (const patch of [
    { inputToken: usdc.address },
    { outputToken: usdt.address },
    { taker: config.sor },
    { recipient: config.sor },
    { maxInputAmount: (budget + 1n).toString() },
    { initialDepositAmount: "0" },
    { minOutputAmount: "0" },
    { deadline: 1700 },
  ]) {
    const q = quote();
    Object.assign(q.route_params, patch);
    assert.throws(() => validateQuote(q, input, usdc, owner, budget, 1600, clock));
  }
  const expired = quote();
  expired.expires_at = 1002;
  assert.throws(
    () => validateQuote(expired, input, usdc, owner, budget, 1600, clock),
    /expired_quote/,
  );
});
test("batch rejects missing items, marks individual failures and verifies positional tokens", async () => {
  await assert.rejects(
    new Sera(batchTransport([])).quotes(input, [usdc], owner, budget, clock),
    /invalid_batch_length/,
  );
  const failed = await new Sera(
    batchTransport([
      { ok: true, quote: quote() },
      { ok: false, error: { message: "private internal text" } },
    ]),
  ).quotes(input, [usdc, usdt], owner, budget, clock);
  assert.equal(required(failed[0]).quote?.route_params.minOutputAmount, "63059999");
  assert.equal(required(failed[1]).reason, "quote_rejected");
  const swapped = await new Sera(batchTransport([{ ok: true, quote: quote(usdt) }])).quotes(
    input,
    [usdc],
    owner,
    budget,
    clock,
  );
  assert.equal(required(swapped[0]).reason, "quote_address_mismatch");
});
test("selection uses BigInt with different decimals and deterministic ties", () => {
  const six = candidate(usdc, "63059999");
  const eighteen = candidate({ ...usdt, decimals: 18 }, "63060000000000000000");
  assert.equal(
    select(decision(), ["USDC", "USDT"], [six, eighteen], clock).selected?.token.symbol,
    "USDT",
  );
  required(eighteen.quote).route_params.minOutputAmount = "63059999000000000000";
  assert.equal(
    select(decision(), ["USDT", "USDC"], [eighteen, six], clock).selected?.token.symbol,
    "USDC",
  );
  assert.equal(summary(six).min_output, "63.059999"); // ガス控除済みの受取額を表示する。追加の控除はしない。
});
test("partial comparison, expired quote, required destination and confidence stop selection", () => {
  const good = candidate();
  assert.equal(select(decision(), ["USDC", "USDT"], [good], clock).reason, "incomplete_comparison");
  const second = candidate(usdt, "99999999");
  assert.equal(
    select(decision("prefer_usdc"), ["USDC", "USDT"], [good, second], clock).selected?.token.symbol,
    "USDC",
  );
  assert.equal(
    select(decision("prefer_usdc"), ["USDT"], [second], clock).reason,
    "destination_not_allowed",
  );
  assert.equal(
    select(decision("best_quote", 0.79), ["USDC"], [good], clock).reason,
    "low_confidence",
  );
  assert.equal(select(decision(), ["USDC"], [good], { now: () => 1030 }).selected, null);
});
for (const [policy, confidence, allow] of [
  ["wait", 0.99, ["USDC"]],
  ["best_quote", 0.7, ["USDC"]],
  ["prefer_usdt", 0.99, ["USDC"]],
] as const) {
  test(`prepare ${policy}/${confidence} skips Sera entirely`, async () => {
    let calls = 0;
    const sera = new Sera(async () => {
      calls++;
      throw new Error("should_not_call");
    });
    const result = await prepare(
      { amount: "10000", allow: [...allow], request: "offline" },
      { WALLET_ADDRESS: owner, TYPESAFE_API_KEY: "offline" },
      { classify: async () => decision(policy, confidence), sera },
    );
    assert.equal(calls, 0);
    assert.equal(result.selected, null);
    assert.doesNotThrow(() => JSON.stringify(report(result)));
  });
}
test("integrated preview obtains gas-adjusted quotes and outputs JSON without signing", async () => {
  const paths: string[] = [];
  const sera = new Sera(async (url, init) => {
    const path = String(url).slice(API_BASE.length);
    paths.push(path);
    if (path === "/config") return Response.json(configWire);
    if (path === "/tokens") return Response.json(registry);
    if (path === "/system/time") return Response.json({ timestamp: 1000 });
    assert.equal(path, "/swap/quote/batch");
    const body = JSON.parse(required(init).body as string) as {
      quotes: { expiration: number; gas_mode: string; from_amount: string }[];
    };
    assert.equal(required(body.quotes[0]).gas_mode, "receive_less");
    assert.equal(required(body.quotes[0]).from_amount, budget.toString());
    return Response.json({
      items: [usdc, usdt].map((t, i) => ({
        ok: true,
        quote: quote(t, i ? "61729999" : "63059999", required(body.quotes[i]).expiration),
      })),
    });
  });
  const result = await prepare(
    { amount: "10000", allow: ["USDC", "USDT"], request: "offline" },
    { WALLET_ADDRESS: owner, TYPESAFE_API_KEY: "offline" },
    { classify: async () => decision(), sera },
  );
  assert.equal(report(result).selected?.symbol, "USDC");
  assert.equal(paths.includes("/swap"), false);
  assert.equal(JSON.stringify(report(result)).includes("permit_signature"), false);
});
test("GET may retry once; quote/swap POST never retry on HTTP or transport failure", async () => {
  let calls = 0;
  const sera = new Sera(async () =>
    ++calls === 1
      ? new Response(null, { status: 503, headers: { "Retry-After": "0" } })
      : Response.json({ ok: true }),
  );
  await sera.request("/config");
  assert.equal(calls, 2);
  for (const status of [401, 429, 503]) {
    let posts = 0;
    await assert.rejects(
      new Sera(async () => {
        posts++;
        return new Response("secret", { status });
      }).request("/swap", {}),
      new RegExp(`sera_http_${status}`),
    );
    assert.equal(posts, 1);
  }
  await assert.rejects(
    new Sera(async () => new Response("not-json")).request("/tokens"),
    /invalid_sera_json/,
  );
  await assert.rejects(
    new Sera(async () => {
      throw new Error("secret transport error");
    }).request("/tokens"),
    /sera_transport_failed/,
  );
});
// 実行処理: 署名内容の復元、保存前の送信禁止、結果不明時の再送禁止を確認する。
test("Intent and Permit offline signatures recover the test wallet with exact values", async () => {
  const q = quote(),
    p = permitPayload(q, config),
    body = await signedBody(wallet, q, config);
  assert.equal(body.uuid, q.uuid);
  assert.equal(body.permit_deadline, 1600);
  assert.equal(verifyTypedData(config.domain, INTENT_TYPES, q.route_params, body.signature), owner);
  assert.equal(verifyTypedData(p.domain, p.types, p.message, body.permit_signature), owner);
  assert.equal(
    verifyTypedData(
      config.domain,
      INTENT_TYPES,
      { ...q.route_params, minOutputAmount: "1" },
      body.signature,
    ) === owner,
    false,
  );
});
test("Permit rejects mainnet, arbitrary schema, wrong spender, budget and unsupported branch", () => {
  for (const mutate of [
    (p: ReturnType<typeof quote>["permit"]) => {
      p.eip712.domain.chainId = 1;
    },
    (p: ReturnType<typeof quote>["permit"]) => {
      p.eip712.types = { Permit: [...PERMIT_TYPES.Permit, { name: "hidden", type: "uint256" }] };
    },
    (p: ReturnType<typeof quote>["permit"]) => {
      p.eip712.message.spender = config.domain.verifyingContract;
    },
    (p: ReturnType<typeof quote>["permit"]) => {
      p.eip712.message.value = (budget + 1n).toString();
    },
    (p: ReturnType<typeof quote>["permit"]) => {
      p.permit_supported = false;
    },
  ]) {
    const q = structuredClone(quote());
    mutate(q.permit);
    assert.throws(() => permitPayload(q, config));
  }
});
test("signed body is private and saved before POST; existing file prevents POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-sera-test-")),
    file = join(dir, "signed.json");
  try {
    const body = await signedBody(wallet, quote(), config);
    let calls = 0;
    const sera = new Sera(async (url, init) => {
      calls++;
      assert.equal(String(url), `${API_BASE}/swap`);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), body);
      assert.deepEqual(JSON.parse(required(init).body as string), body);
      return Response.json({ success: true, status: "pending", trade_id: "trade-test" });
    });
    assert.deepEqual(await submitSaved(sera, body, file), {
      status: "accepted",
      trade_id: "trade-test",
    });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(submitSaved(sera, body, file));
    assert.equal(calls, 1);
    await assert.rejects(submitSaved(sera, body, join(dir, "missing", "body.json")));
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("ambiguous submit keeps saved body and makes exactly one POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-sera-test-"));
  try {
    let calls = 0;
    const sera = new Sera(async () => {
      calls++;
      throw new Error("timeout after accept");
    });
    const result = await submitSaved(
      sera,
      await signedBody(wallet, quote(), config),
      join(dir, "body.json"),
    );
    assert.equal(result.status, "unknown");
    assert.equal(calls, 1);
    await assert.rejects(
      submitSaved(
        sera,
        await signedBody(wallet, quote(), config),
        join(dir, "expired.json"),
        () => {
          throw new Error("expired_quote");
        },
      ),
    );
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const hash = `0x${"ab".repeat(32)}`;
function order(status: string) {
  return {
    trade_id: "trade-test",
    owner_address: owner,
    order_type: "swap",
    status,
    settlement_summary: {
      status: "settled",
      total_fill_count: 1,
      settled_fill_count: 1,
      pending_fill_count: 0,
      failed_fill_count: 0,
      reverted_fill_count: 0,
      latest_parent_status: "confirmed",
      latest_fill_settlement_status: "settled",
      latest_tx_hash: hash,
    },
  };
}
function pollingControls() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    timeout: 6000,
  };
}
// 決済確認: APIの受付・決済状態と、チェーン上のreceipt成功を区別する。
test("pending is not settlement; API settled and successful receipt are both required", async () => {
  let calls = 0,
    receipts = 0;
  const sera = new Sera(async (_url, init) => {
    assert.equal(new Headers(required(init).headers).get("Authorization"), "Bearer test:offline");
    return Response.json(order(++calls === 1 ? "pending" : "settled"));
  });
  const result = await poll(
    sera,
    "Bearer test:offline",
    "trade-test",
    owner,
    {
      getTransactionReceipt: async () => {
        receipts++;
        return { hash, status: 1 };
      },
    },
    pollingControls(),
  );
  assert.equal(result.status, "settled");
  assert.equal(calls, 2);
  assert.equal(receipts, 1);
});
test("timeout, reverted receipt, failed order and wrong owner do not report success", async () => {
  const rpc = { getTransactionReceipt: async () => ({ hash, status: 0 }) };
  assert.equal(
    (
      await poll(
        new Sera(async () => Response.json(order("pending"))),
        "offline",
        "trade-test",
        owner,
        rpc,
        pollingControls(),
      )
    ).reason,
    "poll_timeout",
  );
  assert.equal(
    (
      await poll(
        new Sera(async () => Response.json(order("settled"))),
        "offline",
        "trade-test",
        owner,
        rpc,
        pollingControls(),
      )
    ).reason,
    "receipt_reverted",
  );
  assert.equal(
    (
      await poll(
        new Sera(async () => Response.json(order("failed"))),
        "offline",
        "trade-test",
        owner,
        rpc,
        pollingControls(),
      )
    ).status,
    "failed",
  );
  assert.equal(
    (
      await poll(
        new Sera(async () => Response.json({ ...order("settled"), owner_address: config.sor })),
        "offline",
        "trade-test",
        owner,
        rpc,
        pollingControls(),
      )
    ).reason,
    "order_mismatch",
  );
});

/**
 * execute/status専用の入口。previewの結果を使い、再Quote → 署名 → 保存 → 送信 → 決済確認を行う。
 * 送信後に結果が不明ならunknownとして停止し、自動で新しいSwapを始めない。
 */

import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  type TypedDataDomain,
  type TypedDataField,
  Wallet,
} from "ethers";
import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { envValue, fail, isMain, type Options, options, prepare, report, select } from "./index.js";
import {
  address,
  amountRaw,
  CHAIN_ID,
  type Config,
  type Quote,
  record,
  sameAddress,
  Sera,
  summary,
  uint,
} from "./sera.js";

// EIP-712の型定義。フィールド名・型・順序も署名対象の型を決めるので固定する。
// Intentは交換条件への同意、PermitはJPYCをSORが移動するための許可を表す。
export const INTENT_TYPES = {
  Intent: [
    { name: "taker", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
    { name: "deadline", type: "uint48" },
  ],
};
export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * APIのPermitをそのまま署名する前に、固定schemaと内容を検査する。
 * JPYCのPermit対応経路に限定し、別のspender・金額・チェーンへの許可を防ぐ。
 */
export function permitPayload(quote: Quote, config: Config) {
  const p = record(quote.permit);
  if (p.permit_supported !== true || p.permit_required !== true)
    throw new Error("unsupported_permit_path");
  const e = record(p.eip712),
    d = record(e.domain),
    m = record(e.message),
    t = record(e.types);
  // 想定外の型やフィールドを含む署名依頼を受け付けない。
  const schema = t.Permit;
  if (
    e.primaryType !== "Permit" ||
    Object.keys(t).length !== 1 ||
    !Array.isArray(schema) ||
    schema.length !== PERMIT_TYPES.Permit.length ||
    !schema.every((v, i) => {
      const field = record(v),
        expected = PERMIT_TYPES.Permit[i];
      return (
        expected !== undefined &&
        Object.keys(field).length === 2 &&
        field.name === expected.name &&
        field.type === expected.type
      );
    }) ||
    Object.keys(m).sort().join(",") !== "deadline,nonce,owner,spender,value"
  )
    throw new Error("invalid_permit_schema");
  // owner・spender・金額・nonce・期限を、Quoteとlive設定に照合する。
  if (
    d.name !== "JPYC Inc." ||
    d.version !== "1" ||
    d.chainId !== CHAIN_ID ||
    Object.keys(d).sort().join(",") !== "chainId,name,verifyingContract,version" ||
    !sameAddress(d.verifyingContract, quote.route_params.inputToken) ||
    !sameAddress(m.owner, quote.route_params.taker) ||
    !sameAddress(m.spender, config.sor) ||
    !sameAddress(p.token, d.verifyingContract) ||
    !sameAddress(p.owner, m.owner) ||
    !sameAddress(p.spender, m.spender) ||
    uint(m.value) !== uint(quote.route_params.initialDepositAmount) ||
    uint(p.value_raw) !== uint(m.value) ||
    uint(m.nonce) !== uint(p.nonce) ||
    uint(m.deadline) !== uint(quote.route_params.deadline) ||
    typeof m.deadline !== "number" ||
    !Number.isSafeInteger(m.deadline)
  )
    throw new Error("invalid_permit_values");
  const outer = record(p.domain);
  if (
    outer.name !== d.name ||
    outer.version !== d.version ||
    outer.chainId !== d.chainId ||
    !sameAddress(outer.verifyingContract, d.verifyingContract)
  )
    throw new Error("invalid_permit_domain");
  return {
    domain: d as TypedDataDomain,
    types: t as Record<string, TypedDataField[]>,
    message: m,
    deadline: m.deadline,
  };
}

/**
 * 署名はローカルのウォレットで作る。この関数自体はチェーンやAPIへ送信しない。
 * QuoteのIDは送信用、route_params.uuidはIntent署名用として、それぞれ元の値を使う。
 */
export async function signedBody(wallet: Wallet, quote: Quote, config: Config) {
  if (!sameAddress(wallet.address, quote.route_params.taker)) throw new Error("wallet_mismatch");
  const p = permitPayload(quote, config);
  return {
    uuid: quote.uuid,
    signature: await wallet.signTypedData(config.domain, INTENT_TYPES, quote.route_params),
    permit_signature: await wallet.signTypedData(p.domain, p.types, p.message),
    permit_deadline: p.deadline,
  };
}

/** 
 * 署名を含む記録を自分だけが読み書きできる0600で新規作成し、上書きは拒否する。 
 */
export async function savePrivate(file: string, data: unknown) {
  const handle = await open(file, "wx", 0o600);
  // POST前に書き込みを完了し、syncでファイルの内容をストレージへ反映する。
  try {
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 
 * 完全な送信bodyを保存した後に、Swapを1回だけ送信する。
 */
export async function submitSaved(
  sera: Sera,
  body: Awaited<ReturnType<typeof signedBody>>,
  file: string,
  beforePost: () => void = () => {},
) {
  // 保存が失敗したらPOSTに進まない。beforePostは保存後の期限確認とロック維持に使う。
  await savePrivate(file, body);
  beforePost();
  try {
    const r = record(await sera.request("/swap", body));
    if (
      r.success !== true ||
      typeof r.trade_id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(r.trade_id)
    )
      return { trade_id: null, status: "unknown" as const };
    // acceptedは受付済みという意味。決済完了はpollで別途確認する。
    return { trade_id: r.trade_id, status: "accepted" as const };
    // 応答を失ってもサーバーは受付済みかもしれないので、失敗と断定せず再送もしない。
  } catch {
    return { trade_id: null, status: "unknown" as const };
  }
}

export interface ReceiptReader {
  getTransactionReceipt(hash: string): Promise<{ status: number | null; hash: string } | null>;
}

/**
 * 注文APIを約2秒間隔・最大約120秒で照会する。pending/matchedは完了として扱わない。
 * controlsを差し替えると、テストでは実時間の待機なしでタイムアウトを検証できる。
 */
export async function poll(
  sera: Sera,
  auth: string,
  tradeId: string,
  owner: string,
  rpc: ReceiptReader,
  controls = {
    now: () => performance.now(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    timeout: 120_000,
  },
) {
  const end = controls.now() + controls.timeout;
  while (controls.now() < end) {
    try {
      const order = record(
        await sera.request(`/orders/${encodeURIComponent(tradeId)}`, undefined, auth),
      );
      // 他の注文やownerの結果を、今回のSwapの結果と取り違えないようにする。
      if (
        order.trade_id !== tradeId ||
        order.order_type !== "swap" ||
        !sameAddress(order.owner_address, owner)
      )
        return { status: "unknown", trade_id: tradeId, reason: "order_mismatch" };
      if (order.status === "failed" || order.status === "cancelled")
        return { status: order.status, trade_id: tradeId };
      if (order.status === "settled") {
        const s = record(order.settlement_summary);
        // API上で全fillが決済済み、失敗・未決済が0であることを確認する。
        if (
          s.status === "settled" &&
          s.latest_parent_status === "confirmed" &&
          s.latest_fill_settlement_status === "settled" &&
          typeof s.total_fill_count === "number" &&
          s.total_fill_count > 0 &&
          Number.isSafeInteger(s.total_fill_count) &&
          s.settled_fill_count === s.total_fill_count &&
          s.pending_fill_count === 0 &&
          s.failed_fill_count === 0 &&
          s.reverted_fill_count === 0 &&
          typeof s.latest_tx_hash === "string" &&
          /^0x[0-9a-fA-F]{64}$/.test(s.latest_tx_hash)
        ) {
          // 加えて最新の決済txのreceiptを確認する。全fillの個別receiptまでは照合しない。
          // receipt成功だけでは内部の取引成功を断定できないため、上のAPI確認も必要。
          const receipt = await rpc.getTransactionReceipt(s.latest_tx_hash);
          if (
            receipt?.hash.toLowerCase() === s.latest_tx_hash.toLowerCase() &&
            receipt.status === 1
          )
            return { status: "settled", trade_id: tradeId, tx_hash: receipt.hash };
          if (receipt?.status === 0)
            return { status: "unknown", trade_id: tradeId, reason: "receipt_reverted" };
        }
      } else if (!["pending", "matched"].includes(String(order.status))) {
        return { status: "unknown", trade_id: tradeId, reason: "invalid_order_status" };
      }
    } catch {
      return { status: "unknown", trade_id: tradeId, reason: "status_query_failed" };
    }
    await controls.sleep(Math.min(2000, Math.max(0, end - controls.now())));
  }
  return { status: "unknown", trade_id: tradeId, reason: "poll_timeout" };
}

/** 
 * CLIの実行処理。照会だけのstatusと、署名が必要なexecuteを分岐する。
 */
async function run(input: Options) {
  const owner = address(envValue(process.env, "WALLET_ADDRESS"));
  const rpcRequest = new FetchRequest(envValue(process.env, "SEPOLIA_RPC_URL"));
  rpcRequest.timeout = 10_000;
  const rpc = new JsonRpcProvider(rpcRequest);
  try {
    // APIだけでなくRPCもSepoliaであることを確認してから署名・照会へ進む。
    if ((await rpc.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error("wrong_rpc_chain");
    const auth = `Bearer ${envValue(process.env, "SERA_API_KEY")}:${envValue(process.env, "SERA_API_SECRET")}`;
    const sera = new Sera();
    const dir = resolve("runs/private");
    const lockFile = resolve(dir, `${owner.toLowerCase()}.lock`);
    // statusでは秘密鍵を読まず、既存のtrade_idの決済状態だけを追跡する。
    if (input.status) {
      const result = await poll(sera, auth, input.status, owner, rpc);
      if (["settled", "failed", "cancelled"].includes(result.status)) {
        // 決済完了・失敗・キャンセルが確認できた、同じ注文のロックだけを解除する。
        try {
          const lock = record(JSON.parse(await readFile(lockFile, "utf8")));
          if (lock.trade_id === input.status) await unlink(lockFile);
        } catch {
          /* ロックがない、または内容が不明な場合は変更しない。 */
        }
      }
      return { mode: "status", chain_id: CHAIN_ID, ...result };
    }
    const wallet = new Wallet(envValue(process.env, "TESTNET_PRIVATE_KEY"));
    if (!sameAddress(wallet.address, owner)) throw new Error("wallet_mismatch");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let lock: FileHandle;
    // wxは既存ファイルがあると失敗する。同じフォルダ・ownerの同時実行を防ぐ。
    try {
      lock = await open(lockFile, "wx", 0o600);
    } catch {
      throw new Error("execution_locked");
    }
    // trueは「POSTされた可能性がある」という意味。結果不明のときはロックを残す。
    let submitted = false;
    try {
      // 受付後に注文を追跡できるよう、署名前に状態照会用キーが使えるか確認する。
      await sera.request(
        `/orders?owner_address=${owner.toLowerCase()}&type=swap&limit=1`,
        undefined,
        auth,
      );
      const result = await prepare(input, process.env, {
        classify: (await import("./jev.js")).classify,
        sera,
      });
      if (!result.context || !result.selected)
        return { ...report(result), mode: "execute", status: "skipped" };
      const ctx = result.context;
      // APIのdecimalsをオンチェーン値と照合し、全額入金できるJPYC残高も確認する。
      const token = new Contract(
        ctx.input.address,
        [
          "function decimals() view returns (uint8)",
          "function balanceOf(address) view returns (uint256)",
        ],
        rpc,
      );
      if (Number(await token.getFunction("decimals")()) !== ctx.input.decimals)
        throw new Error("token_decimals_mismatch");
      if (BigInt(await token.getFunction("balanceOf")(owner)) < ctx.budget)
        throw new Error("insufficient_jpyc_balance");
      // 古いpreview Quoteは署名に使わず、実行直前に取り直す。
      // best_quoteは全許可候補、指定先の方針はその候補だけを再取得する。
      const outputs =
        result.decision.policy === "best_quote" ? ctx.outputs : [result.selected.token];
      const clock = await sera.clock();
      const fresh = await sera.quotes(ctx.input, outputs, owner, ctx.budget, clock);
      const selection = select(result.decision, input.allow, fresh, clock);
      const chosen = selection.selected;
      const quote = chosen?.quote;
      if (!chosen || !quote)
        return { mode: "execute", status: "skipped", reason: selection.reason };
      // 利用者の最低受取条件を整数で確認し、条件を緩めたりQuoteを改変したりしない。
      if (input.minOutput === undefined) throw new Error("missing_or_invalid_min_output");
      if (
        uint(quote.route_params.minOutputAmount) < amountRaw(input.minOutput, chosen.token.decimals)
      )
        throw new Error("below_min_output");
      const body = await signedBody(wallet, quote, ctx.config);
      if (quote.expires_at <= clock.now() + 2) throw new Error("expired_quote");
      // 送信内容の保存先をロックにも記録し、中断後に調査できるようにする。
      const journal = resolve(dir, `${quote.uuid}.json`);
      await lock.writeFile(JSON.stringify({ uuid: quote.uuid, journal, trade_id: null }));
      await lock.sync();
      const submission = await submitSaved(sera, body, journal, () => {
        if (quote.expires_at <= clock.now() + 2) throw new Error("expired_quote");
        // ここからは受付済みの可能性がある。応答が不明でもロックを維持する。
        submitted = true;
      });
      // 受付IDはQuote IDとは別物。再照会に使えるよう、署名bodyと別ファイルに保存する。
      if (submission.trade_id) {
        try {
          await savePrivate(resolve(dir, `${quote.uuid}.accepted.json`), submission);
          await lock.truncate(0);
          await lock.write(
            JSON.stringify({ uuid: quote.uuid, journal, trade_id: submission.trade_id }),
            0,
          );
          await lock.sync();
        } catch {
          return {
            mode: "execute",
            chain_id: CHAIN_ID,
            status: "unknown",
            trade_id: submission.trade_id,
            quote_id: quote.uuid,
            journal,
            reason: "acceptance_save_failed",
          };
        }
      }
      const status = submission.trade_id
        ? await poll(sera, auth, submission.trade_id, owner, rpc)
        : submission;
      if (["settled", "failed", "cancelled"].includes(status.status)) {
        submitted = false;
      }
      return {
        mode: "execute",
        chain_id: CHAIN_ID,
        decision: result.decision,
        selected: summary(chosen),
        quote_id: quote.uuid,
        journal,
        ...status,
      };
    } finally {
      await lock.close();
      // 送信前の停止、または終端状態が確認できた場合だけ、次の実行を許可する。
      if (!submitted) await unlink(lockFile);
    }
  } finally {
    rpc.destroy();
  }
}
if (isMain(import.meta.url)) {
  (async () => {
    const result = await run(options(process.argv.slice(2), true));
    console.log(JSON.stringify(result, null, 2));
    if (["unknown", "failed", "cancelled"].includes(result.status)) process.exitCode = 1;
  })().catch(fail);
}

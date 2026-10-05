/**
 * previewの入口。CLI入力 → Jevの分類 → Seraの見積もり → 整数比較の順で処理する。
 * このファイルは署名・Swap送信を行わない。実行処理はexecute.tsに分けている。
 */

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { classify, type Decision } from "./jev.js";
import {
  address,
  amountRaw,
  type Candidate,
  CHAIN_ID,
  type Clock,
  type Destination,
  type Quote,
  Sera,
  summary,
} from "./sera.js";

// amountとminOutputは表示単位の文字列。トークンのdecimals取得後に整数へ変換する。
export interface Options {
  amount: string;
  allow: Destination[];
  request: string;
  minOutput?: string;
  status?: string;
}
/** 
 * 外部APIを呼ぶ前に、必須引数・候補・金額の基本形式を検査する。
 */
export function options(args: string[], execute = false): Options {
  const { values } = parseArgs({
    args,
    options: {
      amount: { type: "string" },
      allow: { type: "string" },
      request: { type: "string" },
      ...(execute
        ? {
            "min-output": { type: "string" as const },
            status: { type: "boolean" as const },
            "trade-id": { type: "string" as const },
          }
        : {}),
    },
  });
  // statusは既存注文の照会だけなので、新しい交換希望や金額を必要としない。
  if (execute && values.status) {
    if (
      typeof values["trade-id"] !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(values["trade-id"])
    )
      throw new Error("invalid_trade_id");
    return { amount: "", allow: [], request: "", status: values["trade-id"] };
  }
  if (
    typeof values.amount !== "string" ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(values.amount) ||
    !/[1-9]/.test(values.amount) ||
    values.amount.length > 120
  )
    throw new Error("invalid_amount");
  if (typeof values.allow !== "string") throw new Error("missing_allow");
  // allowは利用者が決める制約。モデルの判断で候補を増やさない。
  const allow = values.allow.split(",");
  if (
    !allow.length ||
    allow.some((v) => v !== "USDC" && v !== "USDT") ||
    new Set(allow).size !== allow.length
  )
    throw new Error("invalid_allow");
  if (typeof values.request !== "string" || !values.request.trim() || values.request.length > 2000)
    throw new Error("invalid_request");
  // 実行時は最低受取数量を必須にし、再見積もりで条件を下回ったら止める。
  const minOutput = values["min-output"];
  if (
    execute &&
    (typeof minOutput !== "string" ||
      minOutput.length > 120 ||
      !/^(0|[1-9]\d*)(\.\d+)?$/.test(minOutput) ||
      !/[1-9]/.test(minOutput))
  )
    throw new Error("missing_or_invalid_min_output");
  return {
    amount: values.amount,
    allow: allow as Destination[],
    request: values.request,
    ...(typeof minOutput === "string" ? { minOutput } : {}),
  };
}

/** 
 * 未設定の環境変数は名前だけを示す。値をエラーに含めない。
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing_${name.toLowerCase()}`);
  return v;
}

// サンプル用の固定閾値。実データで校正した正解率・約定成功率ではない。
export const MIN_CONFIDENCE = 0.8;

/** 
 * 見送り条件を先に確認し、不要なQuote取得や許可外の選択を防ぐ。 
 */
export function stopReason(decision: Decision, allow: readonly Destination[]): string | null {
  if (decision.policy === "wait") return "policy_wait";
  if (decision.confidence < MIN_CONFIDENCE) return "low_confidence";
  const required =
    decision.policy === "prefer_usdc" ? "USDC" : decision.policy === "prefer_usdt" ? "USDT" : null;
  return required && !allow.includes(required) ? "destination_not_allowed" : null;
}

/**
 * Jevの方針を、検査済みの見積もりと利用者の制約に適用する。
 * 指定先が使えなくても別トークンには切り替えず、比較が不完全なら見送る。
 */
export function select(
  decision: Decision,
  allow: readonly Destination[],
  candidates: Candidate[],
  clock: Clock,
) {
  const stop = stopReason(decision, allow);
  if (stop) return { selected: null, reason: stop };
  const wanted =
    decision.policy === "best_quote"
      ? allow
      : [decision.policy === "prefer_usdc" ? "USDC" : "USDT"];
  const valid: (Candidate & { quote: Quote })[] = [];
  // 比較対象は全件そろっている必要がある。期限には2秒の余裕を要求する。
  for (const symbol of wanted) {
    const matches = candidates.filter((c) => c.token.symbol === symbol);
    const c = matches[0];
    if (
      matches.length !== 1 ||
      !c?.quote ||
      Math.min(c.quote.expires_at, c.quote.route_params.deadline) <= clock.now() + 2
    ) {
      return {
        selected: null,
        reason:
          decision.policy === "best_quote"
            ? "incomplete_comparison"
            : "required_destination_unavailable",
      };
    }
    valid.push({ ...c, quote: c.quote });
  }
  // decimalsの違いを共通の桁にそろえ、浮動小数点を使わずBigIntで比較する。
  // USDC/USDTを同じUSD単位の数量として扱う前提で、市場価値の比較ではない。
  valid.sort((a, b) => {
    const scale = Math.max(a.token.decimals, b.token.decimals);
    const left =
      BigInt(a.quote.route_params.minOutputAmount) * 10n ** BigInt(scale - a.token.decimals);
    const right =
      BigInt(b.quote.route_params.minOutputAmount) * 10n ** BigInt(scale - b.token.decimals);
    // 大きい数量を先頭へ置き、完全に同じ数量ならUSDCを優先する。
    return left > right
      ? -1
      : left < right
        ? 1
        : a.token.symbol === b.token.symbol
          ? 0
          : a.token.symbol === "USDC"
            ? -1
            : 1;
  });
  return {
    selected: valid[0] ?? null,
    reason:
      decision.policy === "best_quote" && allow.length > 1
        ? "greatest_received_quantity"
        : "required_or_only_destination",
  };
}

/**
 * previewとexecuteが共有する準備処理。dependenciesの差し替えで通信をモック化できる。
 * 公開結果に加え、実行拡張で使う設定・整数金額・時計をcontextに保持する。
 */
export async function prepare(
  input: Options,
  env: NodeJS.ProcessEnv = process.env,
  dependencies = { classify, sera: new Sera() },
) {
  const start = performance.now();
  const owner = address(envValue(env, "WALLET_ADDRESS"));
  // 1. 自然言語を分類し、見送りならSera APIを呼ばずに結果を返す。
  const decision = await dependencies.classify(
    input.request,
    input.allow,
    envValue(env, "TYPESAFE_API_KEY"),
  );
  const jevMs = performance.now() - start;
  const stop = stopReason(decision, input.allow);
  if (stop)
    return {
      decision,
      candidates: [] as Candidate[],
      selected: null,
      reason: stop,
      timings: { jev_ms: jevMs, sera_ms: 0, total_ms: performance.now() - start },
      context: null,
    };
  const sera = dependencies.sera;
  // 2. Sepolia設定とトークン情報を取得し、そのdecimalsでJPYCの金額を変換する。
  const registry = await sera.initialize(input.allow);
  const budget = amountRaw(input.amount, registry.input.decimals);
  const clock = await sera.clock();
  // 3. 許可候補の見積もりをまとめて取得し、コードで交換先を選ぶ。
  const candidates = await sera.quotes(registry.input, registry.outputs, owner, budget, clock);
  const selection = select(decision, input.allow, candidates, clock);
  return {
    decision,
    candidates,
    ...selection,
    timings: {
      jev_ms: jevMs,
      sera_ms: performance.now() - start - jevMs,
      total_ms: performance.now() - start,
    },
    context: { sera, owner, budget, clock, ...registry },
  };
}

/** 
 * 公開用JSONには要約だけを出し、内部contextや署名用の値は含めない。
 */
export function report(result: Awaited<ReturnType<typeof prepare>>) {
  return {
    mode: "preview",
    chain_id: CHAIN_ID,
    decision: result.decision,
    candidates: result.candidates.map(summary),
    selected: result.selected ? summary(result.selected) : null,
    reason: result.reason,
    timings: result.timings,
  };
}

/** 
 * 自由文の例外をそのまま表示せず、短いエラーコードで終了する。
 */
export function fail(error: unknown): void {
  const message =
    error instanceof Error && /^[a-z][a-z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : "sample_failed";
  console.error(JSON.stringify({ error: message }));
  process.exitCode = 1;
}

// テストやexecute.tsからimportしたときは、CLI処理を自動起動しない。
export function isMain(url: string): boolean {
  return !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
}
if (isMain(import.meta.url)) {
  (async () => {
    const result = await prepare(options(process.argv.slice(2)));
    console.log(JSON.stringify(report(result), null, 2));
  })().catch(fail);
}

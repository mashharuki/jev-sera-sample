/**
 * SeraのテストネットRESTクライアントと、API境界の検査・金額変換を担当する。
 * 外部JSONはunknownで受け取り、内容を検査してからアプリの型として扱う。
 */
import { formatUnits, getAddress, parseUnits, TypedDataEncoder } from "ethers";

// 接続先とチェーンを固定し、メインネットへの切り替えは行わない。
export const API_BASE = "https://api.testnet.sera.cx/api/v1";
export const CHAIN_ID = 11155111;
export type Destination = "USDC" | "USDT";
export type Json = Record<string, unknown>;
/** JSONオブジェクトか確認する。各フィールドの検査は呼び出し側で行う。 */
export function record(v: unknown): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid_sera_response");
  return v as Json;
}
/** Solidityのuintに収まる整数だけを受け取る。安全に表せないJavaScriptのnumberは拒否する。 */
export function uint(v: unknown, bits = 256): bigint {
  if (
    (typeof v !== "string" || !/^\d+$/.test(v)) &&
    !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
  )
    throw new Error("invalid_uint");
  const n = BigInt(v as string | number);
  if (n < 0n || n >= 2n ** BigInt(bits)) throw new Error("invalid_uint");
  return n;
}
/** Ethereumアドレスを検査し、チェックサム表記にそろえる。 */
export function address(v: unknown): string {
  if (typeof v !== "string") throw new Error("invalid_address");
  try {
    return getAddress(v);
  } catch {
    throw new Error("invalid_address");
  }
}
export function sameAddress(a: unknown, b: unknown): boolean {
  return address(a) === address(b);
}
/**
 * 表示単位の金額をトークンの最小単位へ変換する。例: decimals=6なら1.23 → 1230000n。
 * 丸めによる金額変更を避けるため、桁超過・指数表記・ゼロ・uint256の範囲外は拒否する。
 */
export function amountRaw(value: string, decimals: number): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals)
    throw new Error("invalid_amount");
  const amount = parseUnits(value, decimals);
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error("invalid_amount");
  return amount;
}
// minも最小単位の整数。アドレス・decimals・最低取引額はAPIから取得する。
export interface Token {
  symbol: "JPYC" | Destination;
  address: string;
  decimals: number;
  min: bigint;
}
export interface Config {
  sor: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
}
export interface Clock {
  now(): number;
}
/** Intentとして署名する値。uuidはQuoteの文字列IDとは別のuint256値。 */
export interface Route {
  taker: string;
  inputToken: string;
  outputToken: string;
  maxInputAmount: string;
  minOutputAmount: string;
  recipient: string;
  initialDepositAmount: string;
  uuid: string;
  deadline: number;
}
// expires_atはQuoteの短い有効期限、route_params.deadlineは署名するIntentの期限。
export interface Quote {
  uuid: string;
  route_params: Route;
  expires_at: number;
  permit: unknown;
}
export interface Candidate {
  token: Token;
  quote: Quote | null;
  reason: string | null;
}

/** Sepoliaと署名domainを検査する。IntentのverifyingContractはSera、PermitのspenderはSOR。 */
export function parseConfig(value: unknown): Config {
  const r = record(value),
    d = record(r.eip712_domain);
  if (r.chain_id !== CHAIN_ID || d.chainId !== CHAIN_ID) throw new Error("wrong_chain");
  if (d.name !== "Sera" || d.version !== "1" || !sameAddress(d.verifyingContract, r.sera_address))
    throw new Error("invalid_domain");
  const domain = {
    name: "Sera",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: address(d.verifyingContract),
  };
  if (r.domain_separator !== TypedDataEncoder.hashDomain(domain)) throw new Error("invalid_domain");
  return { domain, sor: address(r.sor_address) };
}
/** symbolの重複・通貨・decimalsを検査し、必要なトークンだけ取り出す。 */
export function parseTokens(value: unknown, symbols: readonly ("JPYC" | Destination)[]): Token[] {
  const list = record(value).tokens;
  if (!Array.isArray(list)) throw new Error("invalid_tokens");
  return symbols.map((symbol) => {
    const matches = list.map(record).filter((t) => t.symbol === symbol);
    const t = matches[0];
    if (
      matches.length !== 1 ||
      !t ||
      !Number.isInteger(t.decimals) ||
      Number(t.decimals) < 0 ||
      Number(t.decimals) > 36 ||
      t.currency !== (symbol === "JPYC" ? "JPY" : "USD")
    )
      throw new Error("invalid_tokens");
    return {
      symbol,
      address: address(t.address),
      decimals: t.decimals as number,
      min: uint(t.min_trade_amount_raw),
    };
  });
}
/**
 * 返されたQuoteが、要求したトークン・owner・受取先・予算・期限に一致するか検査する。
 * このサンプルは入力の全額をウォレットから入金する経路だけを扱う。
 */
export function validateQuote(
  value: unknown,
  input: Token,
  output: Token,
  owner: string,
  budget: bigint,
  expiration: number,
  clock: Clock,
): Quote {
  const q = record(value),
    r = record(q.route_params);
  if (typeof q.uuid !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(q.uuid))
    throw new Error("invalid_quote_id");
  if (
    !sameAddress(r.inputToken, input.address) ||
    !sameAddress(r.outputToken, output.address) ||
    !sameAddress(r.taker, owner) ||
    !sameAddress(r.recipient, owner)
  )
    throw new Error("quote_address_mismatch");
  for (const key of [
    "maxInputAmount",
    "minOutputAmount",
    "initialDepositAmount",
    "uuid",
  ] as const) {
    if (typeof r[key] !== "string") throw new Error("invalid_quote_amount");
    uint(r[key]);
  }
  if (uint(r.maxInputAmount) !== budget || uint(r.initialDepositAmount) !== budget)
    throw new Error("quote_budget_mismatch");
  // 最低受取数量が0のQuoteは、情報表示用で実行できないため候補から除く。
  if (uint(r.minOutputAmount) === 0n) throw new Error("zero_output");
  if (typeof r.deadline !== "number" || uint(r.deadline, 48) !== BigInt(expiration))
    throw new Error("quote_deadline_mismatch");
  if (
    typeof q.expires_at !== "number" ||
    !Number.isSafeInteger(q.expires_at) ||
    q.expires_at > expiration ||
    Math.min(q.expires_at, expiration) <= clock.now() + 2
  )
    throw new Error("expired_quote");
  const breakdown = q.quote_breakdown;
  if (breakdown && record(breakdown).gas_mode !== "receive_less") throw new Error("wrong_gas_mode");
  // 署名対象は返却された値をそのまま保持する。文字列表記の変更やUUIDの再生成はしない。
  return {
    uuid: q.uuid,
    route_params: r as unknown as Route,
    expires_at: q.expires_at,
    permit: q.permit,
  };
}

export class Sera {
  // fetchを注入できるようにし、テストではネットワークなしでAPI応答を再現する。
  constructor(private readonly transport: typeof fetch = fetch) {}
  /** 共通HTTP処理。bodyなしならGET、bodyありならPOSTとして送る。 */
  async request(path: string, body?: unknown, auth?: string): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = auth;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.transport(`${API_BASE}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("sera_transport_failed");
      }
      // 読み取りGETだけ、429/503を最大1回再試行する。Retry-Afterが2秒以内なら待つ。
      // POSTは再送しない。Quoteは新しいUUIDを発行し、Swapは受付済みの可能性があるため。
      if (body === undefined && attempt === 0 && [429, 503].includes(res.status)) {
        const h = res.headers.get("retry-after");
        const delay = h
          ? /^\d+(\.\d+)?$/.test(h)
            ? Number(h) * 1000
            : Date.parse(h) - Date.now()
          : 500;
        if (Number.isFinite(delay) && delay >= 0 && delay <= 2000) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      if (!res.ok) throw new Error(`sera_http_${res.status}`);
      try {
        return await res.json();
      } catch {
        throw new Error("invalid_sera_json");
      }
    }
  }
  /** チェーン確認を最初に行い、不一致ならトークン取得やQuoteへ進まない。 */
  async initialize(
    allow: readonly Destination[],
  ): Promise<{ config: Config; input: Token; outputs: Token[] }> {
    const config = parseConfig(await this.request("/config"));
    const [input, ...outputs] = parseTokens(await this.request("/tokens"), ["JPYC", ...allow]);
    if (!input) throw new Error("invalid_tokens");
    return { config, input, outputs };
  }
  /** ローカル端末の時刻ずれを避け、サーバー時刻に単調増加する経過時間を足す。 */
  async clock(): Promise<Clock> {
    const start = performance.now();
    const time = record(await this.request("/system/time")).timestamp;
    if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0)
      throw new Error("invalid_server_time");
    // 通信の往復時間も加算し、古いサーバー時刻で有効期限を長く見積もるのを避ける。
    return { now: () => time + (performance.now() - start) / 1000 };
  }
  /** 許可された交換先のQuoteを1回のbatchリクエストで取得する。 */
  async quotes(
    input: Token,
    outputs: Token[],
    owner: string,
    budget: bigint,
    clock: Clock,
  ): Promise<Candidate[]> {
    if (budget < input.min) throw new Error("amount_below_minimum");
    // Intentの期限は約10分先。Quote自体の期限は応答のexpires_atで別途確認する。
    const expiration = Math.floor(clock.now()) + 600;
    const response = record(
      await this.request("/swap/quote/batch", {
        quotes: outputs.map((token) => ({
          from_token: input.address,
          to_token: token.address,
          from_amount: budget.toString(),
          // 受取先を自分に固定し、ガスは受取額から控除するreceive_lessを指定する。
          owner_address: owner,
          recipient: owner,
          expiration,
          gas_mode: "receive_less",
        })),
      }),
    );
    // itemsは要求と同じ順序・件数で返る仕様。対応付けできない応答は全体を拒否する。
    if (!Array.isArray(response.items) || response.items.length !== outputs.length)
      throw new Error("invalid_batch_length");
    // 個別の拒否・不正なQuoteは理由付きの候補として残し、index.tsが見送りを判断する。
    return outputs.map((token, i) => {
      try {
        const item = record((response.items as unknown[])[i]);
        if (item.ok !== true) return { token, quote: null, reason: "quote_rejected" };
        return {
          token,
          quote: validateQuote(item.quote, input, token, owner, budget, expiration, clock),
          reason: null,
        };
      } catch (error) {
        return {
          token,
          quote: null,
          reason: error instanceof Error ? error.message : "invalid_quote",
        };
      }
    });
  }
}
/**
 * 比較に使った最小単位と、人が読む表示単位を両方出力する。
 * receive_lessのminOutputAmountはガス控除済みなので、追加でガスを差し引かない。
 */
export function summary(candidate: Candidate) {
  const q = candidate.quote;
  return {
    symbol: candidate.token.symbol,
    decimals: candidate.token.decimals,
    min_output_raw: q?.route_params.minOutputAmount ?? null,
    min_output: q ? formatUnits(q.route_params.minOutputAmount, candidate.token.decimals) : null,
    expires_at: q?.expires_at ?? null,
    reason: candidate.reason,
  };
}

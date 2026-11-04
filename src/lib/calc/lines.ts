/**
 * Квитанция из строк — окно-конструктор (макет docs/mockups/receipt-constructor-mockup.html).
 * Строка = количество × тариф. Своё у каждого (счётчик) округляется до копеек по арендатору,
 * общее делится до копейки: лишние копейки — частям с бо́льшим остатком, сумма частей = сумма квитанции.
 * Модуль без зависимостей от базы: данные месяца приходят через ReceiptEnv (и в окне — примерные).
 */
import type { ReceiptConfig, ReceiptLine, Reading, Tenant } from './types.ts';
import { fmtMoney, fmtPrice, fmtQty, round2 } from './format.ts';

export interface ReceiptEnv {
  tenants: Tenant[];
  /** Месячное значение квитанции по ключу (см. MonthInput.values). */
  value: (key: string) => number | undefined;
  /** Показание арендатора по строке. */
  reading: (tenantId: string, line: ReceiptLine) => Reading | undefined;
  /** Расход арендатора по квитанции-источнику в единице unit; undefined — у источника нет такого счётчика. */
  source: (id: string, tenantId: string, unit: string) => number | null | undefined;
  sourceName: (id: string) => string;
}

/** Часть счёта арендатора по квитанции (до коэффициента). */
export interface ReceiptPart {
  lab: string;
  sign: 1 | -1;
  how: string;
  sum: number;
  line?: string;
  rest?: boolean;
}

interface Qty {
  ind: boolean;
  Q: number;
  per: Record<string, number>;
  miss: string[];
  cfgMiss?: boolean;
  ref?: ReceiptLine;
  refQ?: Qty;
  k?: number;
  parts?: Record<string, number[]>;
  srcs?: string[];
}

interface Price {
  p: number;
  miss: string[];
  rub?: boolean;
  fromSum?: boolean;
  money?: number;
  base?: number;
}

export interface ReceiptCalc {
  /** Части счёта каждого платящего арендатора (до коэффициента). */
  per: Record<string, ReceiptPart[]>;
  /** Сколько остаётся на вас. */
  mine: number;
  /** Чего ждём в этом месяце. */
  miss: string[];
  /** Что не настроено в окне квитанции. */
  cfg: string[];
  lines: Array<{ l: ReceiptLine; Qi: Qty; pr: Price; sums: Record<string, number> }>;
  rest?: { money: number; txt: string };
  ready: boolean;
}

export const isRub = (l: ReceiptLine) => l.unit === '₽';
export const lineLabel = (cfg: ReceiptConfig, l: ReceiptLine, i: number) => (l.name ? l.name : cfg.lines.length > 1 ? `строка ${i + 1}` : '');
export const coefOf = (cfg: ReceiptConfig) => (cfg.coef > 0 ? cfg.coef : 1);
const pct = (n: number) => fmtQty(Math.round(n * 10) / 10) + '%';
const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Делит сумму по весам до копейки: лишние копейки — частям с бо́льшим остатком. */
export function splitKop(total: number, w: number[]): number[] {
  const W = sumOf(w), c = Math.round(total * 100);
  if (!W || !c) return w.map(() => 0);
  const raw = w.map((x) => (c * x) / W), fl = raw.map(Math.floor);
  let left = c - sumOf(fl);
  raw.map((x, i) => [x - fl[i], i] as const).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  return fl.map((x) => x / 100);
}

/** Расход по показаниям: «было → стало» или «сразу расход»; null — не введено. */
export function usageOf(read: 'diff' | 'direct' | undefined, x: Reading | undefined): number | null {
  if (read === 'direct') return x?.usage == null ? null : Math.max(0, x.usage);
  return x?.cur == null ? null : Math.max(0, x.cur - (x.prev ?? 0));
}

export function calcReceipt(cfg: ReceiptConfig, env: ReceiptEnv): ReceiptCalc {
  const T = env.tenants, P = cfg.pay, off = new Set(P.off ?? []);
  const sharesTotal = sumOf(T.map((t) => t.share));
  const vacant = Math.max(0, 100 - sharesTotal);
  const vacOn = vacant > 0 && P.vacant !== false;
  const effShare = (t: Tenant) => { const D = vacOn ? Math.max(100, sharesTotal) : sharesTotal; return D ? (t.share / D) * 100 : 0; };

  /** Сколько у строки: общее (Q) или у каждого (per). Кто платит сам — показания не нужны. */
  function lineQty(l: ReceiptLine, depth = 0): Qty {
    const per: Record<string, number> = {}, miss: string[] = [], q = l.q;
    if (q.src === 'const') return { ind: false, Q: q.v ?? 0, per, miss: q.v == null ? [isRub(l) ? 'постоянная сумма' : 'постоянный объём'] : [] };
    if (q.src === 'month') { const v = env.value(`${l.id}:v`); return { ind: false, Q: v ?? 0, per, miss: v == null ? [isRub(l) ? 'сумма' : 'объём'] : [] }; }
    if (q.src === 'each') {
      for (const t of T) {
        if (off.has(t.id)) { per[t.id] = 0; continue; }
        const u = usageOf(q.read, env.reading(t.id, l));
        if (u === null) miss.push('показания');
        per[t.id] = u ?? 0;
      }
      return { ind: true, per, Q: sumOf(Object.values(per)), miss: [...new Set(miss)] };
    }
    if (q.src === 'norm') {
      const ref = cfg.lines.find((x) => x.id === q.ref);
      if (!ref || ref === l || depth > 4) return { ind: false, Q: 0, per, miss: [], cfgMiss: true };
      const Rq = lineQty(ref, depth + 1), k = q.k ?? 0;
      if (Rq.ind) for (const t of T) per[t.id] = Rq.per[t.id] * k;
      return { ind: Rq.ind, per, Q: Rq.Q * k, miss: [...Rq.miss, ...(q.k == null ? ['норма'] : [])], ref, refQ: Rq, k };
    }
    // sum: сумма счётчиков других квитанций (в той же единице)
    const srcs = (q.srcs ?? []).filter((id) => T.length === 0 || env.source(id, T[0].id, l.unit) !== undefined);
    const parts: Record<string, number[]> = {};
    for (const t of T) {
      if (off.has(t.id)) { parts[t.id] = []; per[t.id] = 0; continue; }
      parts[t.id] = srcs.map((id) => {
        const u = env.source(id, t.id, l.unit);
        if (u == null) miss.push(`показания «${env.sourceName(id)}»`);
        return u ?? 0;
      });
      per[t.id] = sumOf(parts[t.id]);
    }
    return { ind: true, per, parts, srcs, Q: sumOf(Object.values(per)), miss: [...new Set(miss)], cfgMiss: !srcs.length };
  }

  /** Тариф строки. «Из суммы»: сумма ÷ (общий счётчик или сумма показаний арендаторов), без округления. */
  function priceOf(l: ReceiptLine, Qi: Qty): Price {
    if (isRub(l)) return { p: 1, rub: true, miss: [] };
    if (l.t.mode === 'set') return { p: l.t.p ?? 0, miss: l.t.p == null ? ['тариф'] : [] };
    if (l.t.mode === 'month') { const tp = env.value(`${l.id}:tp`); return { p: tp ?? 0, miss: tp == null ? ['тариф'] : [] }; }
    const money = env.value(`${l.id}:money`), miss = money == null ? ['сумма по квитанции'] : [];
    let base = Qi.Q;
    if (l.t.common) {
      const direct = l.q.read === 'direct' || l.q.src !== 'each';
      const c = direct ? usageOf('direct', { usage: env.value(`${l.id}:camt`) })
        : usageOf('diff', { prev: env.value(`${l.id}:cprev`), cur: env.value(`${l.id}:ccur`) });
      if (c === null) miss.push('общий счётчик');
      base = c ?? 0;
    }
    return { p: base && money ? money / base : 0, fromSum: true, money: money ?? 0, base, miss };
  }

  const qtyHow = (l: ReceiptLine, Qi: Qty, t: Tenant) => {
    if (l.q.src === 'norm' && Qi.ref) return `${fmtQty(Qi.refQ!.per[t.id])} ${Qi.ref.unit} × ${fmtQty(Qi.k!)} = ${fmtQty(Qi.per[t.id])} ${l.unit}`;
    if (l.q.src === 'sum') return `(${Qi.parts![t.id].map(fmtQty).join(' + ') || 0}) ${l.unit}`;
    return `${fmtQty(Qi.per[t.id])} ${l.unit}`;
  };

  /**
   * Делит общую сумму: по долям (доля того, кто платит сам, — на вас) или поровну между теми, кто платит;
   * пустующая часть — на вас (галочка). Делить не на кого — вся сумма на вас.
   */
  function splitCommon(mode: 'shares' | 'equal', total: number) {
    if (mode === 'equal') {
      const w = [...T.map((t) => (off.has(t.id) ? 0 : 1)), vacOn ? 1 : 0], n = sumOf(w);
      if (!n) return { parts: w, mine: total, how: () => '' };
      const parts = splitKop(total, w);
      return { parts, mine: vacOn ? parts[parts.length - 1] : 0, how: () => `÷ ${n}` + (vacOn ? ' (одна часть пустует)' : '') };
    }
    const parts = splitKop(total, [...T.map((t) => t.share), vacOn ? vacant : 0]);
    return { parts, mine: vacOn ? parts[parts.length - 1] : 0, how: (t: Tenant) => `× ${pct(effShare(t))}` };
  }

  const out: ReceiptCalc = { per: {}, mine: 0, miss: [], cfg: [], lines: [], ready: false };
  for (const t of T) out.per[t.id] = [];
  cfg.lines.forEach((l, i) => {
    const Qi = lineQty(l), pr = priceOf(l, Qi), s = l.sign, lab = lineLabel(cfg, l, i), sums: Record<string, number> = {};
    out.miss.push(...Qi.miss, ...pr.miss);
    if (Qi.cfgMiss) out.cfg.push(`строка ${i + 1}: ${l.q.src === 'sum' ? 'не выбраны счётчики' : l.q.src === 'norm' ? 'не выбрана строка' : 'не указано количество'}`);
    const tarTxt = pr.rub ? '' : ` × ${fmtPrice(pr.p)} ₽`;
    if (Qi.ind) {
      if (pr.fromSum && !l.t.common) {
        // вся сумма — по расходу арендаторов, до копейки
        const parts = splitKop(pr.money!, T.map((t) => Qi.per[t.id]));
        T.forEach((t, j) => { sums[t.id] = parts[j]; });
      } else for (const t of T) sums[t.id] = round2(Qi.per[t.id] * pr.p);
      if (pr.fromSum && l.t.common) out.mine += s * round2(pr.money! - sumOf(T.map((t) => sums[t.id])));
      for (const t of T) out.per[t.id].push({ lab, sign: s, how: qtyHow(l, Qi, t) + tarTxt, sum: s * sums[t.id], line: l.id });
    } else {
      const total = pr.fromSum ? pr.money! : round2(Qi.Q * pr.p), S = splitCommon(P.mode, total);
      const baseTxt = pr.rub ? `${fmtMoney(total)} ₽` : `${fmtQty(Qi.Q)} ${l.unit}${tarTxt} = ${fmtMoney(total)} ₽`;
      T.forEach((t, j) => { sums[t.id] = S.parts[j]; out.per[t.id].push({ lab, sign: s, how: `${baseTxt} ${S.how(t)}`, sum: s * S.parts[j], line: l.id }); });
      out.mine += s * S.mine;
    }
    out.lines.push({ l, Qi, pr, sums });
  });

  // Остаток по квитанции: по квитанции больше, чем начислено.
  if (P.rest !== 'none') {
    let B = 0, charged = 0, txt = '';
    if (P.base === 'qty') {
      const L = out.lines.find((x) => x.l.id === P.baseLine);
      if (!L) out.cfg.push('остаток: не выбрана строка');
      else {
        const qty = env.value('qty');
        if (qty == null) out.miss.push('количество по квитанции');
        B = round2((qty ?? 0) * L.pr.p);
        charged = sumOf(T.map((t) => L.l.sign * L.sums[t.id]));
        txt = `${fmtQty(qty ?? 0)} ${L.l.unit} × ${fmtPrice(L.pr.p)} ₽ − начислено`;
      }
    } else {
      const total = env.value('total');
      if (total == null) out.miss.push('итого по квитанции');
      B = total ?? 0;
      charged = sumOf(T.map((t) => sumOf(out.per[t.id].map((x) => x.sum))));
      txt = `${fmtMoney(B)} ₽ − начислено`;
    }
    const rest = Math.max(0, round2(B - charged));
    out.rest = { money: rest, txt };
    if (P.rest === 'self') out.mine += rest;
    else {
      const S = splitCommon(P.rest, rest);
      T.forEach((t, j) => out.per[t.id].push({ lab: 'остаток', sign: 1, how: `${fmtMoney(rest)} ₽ ${S.how(t)}`, sum: S.parts[j], rest: true }));
      out.mine += S.mine;
    }
  }

  // Кто платит сам: его часть в счёт не идёт; общие части — на вас, по своему счётчику — не начисляем.
  const indL = new Set(out.lines.filter((x) => x.Qi.ind).map((x) => x.l.id));
  for (const t of T) {
    if (!off.has(t.id)) continue;
    for (const x of out.per[t.id]) if (x.rest || !indL.has(x.line!)) out.mine += x.sum;
    out.per[t.id] = [];
  }
  out.miss = [...new Set(out.miss)];
  out.ready = !out.miss.length && !out.cfg.length;
  out.mine = round2(out.mine);
  return out;
}

/** Итог арендатора по квитанции с коэффициентом: каждая часть округляется до копеек. */
export const tenantSum = (cfg: ReceiptConfig, C: ReceiptCalc, tenantId: string) =>
  round2(sumOf((C.per[tenantId] ?? []).map((x) => round2(x.sum * coefOf(cfg)))));

/** Месячное поле рамки квитанции: что вписывается каждый месяц, кроме показаний арендаторов. */
export interface MonthField {
  key: string;
  label: string;
  hint?: string;
}

/** Что вписывается каждый месяц в рамке квитанции (по строкам и для остатка). */
export function monthFields(cfg: ReceiptConfig): MonthField[] {
  const f: MonthField[] = [];
  cfg.lines.forEach((l, j) => {
    const lab = lineLabel(cfg, l, j), sfx = lab ? ' · ' + lab : '';
    if (l.q.src === 'month') f.push({ key: `${l.id}:v`, label: `${lab ? lab[0].toUpperCase() + lab.slice(1) : 'Сумма за месяц'}, ${isRub(l) ? '₽' : l.unit}`, hint: l.sign < 0 ? 'вычитается' : undefined });
    if (!isRub(l) && l.t.mode === 'month') f.push({ key: `${l.id}:tp`, label: `Тариф${sfx}, ₽ за ${l.unit}`, hint: 'в этом месяце' });
    if (!isRub(l) && l.t.mode === 'sum') {
      f.push({ key: `${l.id}:money`, label: `Сумма по квитанции${sfx}, ₽`, hint: 'тариф выйдет сам' });
      if (l.t.common) {
        if (l.q.read === 'direct' || l.q.src !== 'each') f.push({ key: `${l.id}:camt`, label: `Общий счётчик, ${l.unit}`, hint: 'расход за месяц' });
        else {
          f.push({ key: `${l.id}:cprev`, label: `Общий счётчик — было, ${l.unit}` });
          f.push({ key: `${l.id}:ccur`, label: `Общий счётчик — стало, ${l.unit}` });
        }
      }
    }
  });
  if (cfg.pay.rest !== 'none') {
    const L = cfg.lines.find((x) => x.id === cfg.pay.baseLine);
    f.push(cfg.pay.base === 'qty'
      ? { key: 'qty', label: `Количество по квитанции${L ? ', ' + L.unit : ''}`, hint: 'для остатка' }
      : { key: 'total', label: 'Итого по квитанции, ₽', hint: 'для остатка' });
  }
  return f;
}

/** Главная сумма квитанции — хранится как сумма счёта на помещение (её видят «Оплаты поставщикам»). */
export function billKeyOf(cfg: ReceiptConfig): string | undefined {
  if (cfg.pay.rest !== 'none' && cfg.pay.base === 'total') return 'total';
  const keys = monthFields(cfg).map((f) => f.key);
  return keys.find((k) => k.endsWith(':money')) ?? keys.find((k) => {
    const l = cfg.lines.find((x) => `${x.id}:v` === k);
    return l && isRub(l) && l.sign > 0;
  });
}

/** Подпись строки показаний: строки «у каждого» (для таблицы показаний в рамке). */
export const meterLines = (cfg: ReceiptConfig) => cfg.lines.filter((l) => l.q.src === 'each');

/** Ключи строк: '' — первая, дальше L2, L3… (зона показаний и префикс месячных значений). */
export function nextLineId(lines: ReceiptLine[]): string {
  const used = new Set(lines.map((l) => l.id));
  if (!used.has('')) return '';
  for (let i = 2; ; i++) if (!used.has(`L${i}`)) return `L${i}`;
}

/** Ключ строки допустим для хранения. */
export const validLineId = (id: string) => /^(|day|night|L\d{1,3})$/.test(id);

/**
 * Модуль расчёта: данные месяца → счёт каждого арендатора.
 * Правила — раздел 7 ТЗ. Все суммы строк округляются до копеек, итог = сумма строк.
 */
import type {
  BillLine, LineGroup, MeterUse, MonthInput, MonthResult, OwnerLine, PropertyObject,
  Reading, Service, Tariff, Tenant, TenantBill,
} from './types.ts';
import { fmtMoney, fmtPrice, fmtQty, round2, sumMoney } from './format.ts';
import { calcReceipt, coefOf, isRub, lineLabel, usageOf, type ReceiptCalc, type ReceiptEnv } from './lines.ts';

/** Действующий тариф услуги для арендатора (или собственника своего объекта) на месяц. «Все» — все без исключения. */
export function activeTariff(service: Service, tenantId: string, month: string): Tariff | null {
  let best: Tariff | null = null;
  for (const t of service.tariffs) {
    const forTenant = t.who === 'all' || t.who.includes(tenantId);
    if (!forTenant || t.from.slice(0, 7) > month) continue;
    if (!best || t.from > best.from) best = t;
  }
  return best;
}

const pct = (share: number) => String(share).replace('.', ',') + '%';

function readingUsage(r: Reading | undefined): { usage: number | null; negative: boolean } {
  if (!r) return { usage: null, negative: false };
  if (typeof r.usage === 'number') return { usage: r.usage, negative: r.usage < 0 };
  if (typeof r.cur !== 'number') return { usage: null, negative: false };
  const prev = typeof r.prev === 'number' ? r.prev : 0;
  const u = r.cur - prev;
  return { usage: u, negative: u < 0 };
}

interface Ctx {
  input: MonthInput;
  obj: PropertyObject;
  /** Расчёт квитанций из строк этого объекта: serviceId → результат. */
  rc: Map<string, ReceiptCalc>;
}

/** Квитанция объекта относится только к своему объекту; старые услуги аккаунта — к любому. */
const onObject = (s: Service, obj: PropertyObject) => !s.objectId || s.objectId === obj.id;

/** Ключ показаний строки квитанции: первая строка — как у старых квитанций, остальные — зона = ключ строки. */
export const lineKey = (serviceId: string, lineId: string) => (lineId ? `${serviceId}:${lineId}` : serviceId);

/** Данные месяца для квитанции из строк. */
function receiptEnv(input: MonthInput, obj: PropertyObject, s: Service): ReceiptEnv {
  const cfg = s.config!;
  return {
    tenants: obj.tenants,
    value: (k) => (k === cfg.billKey ? input.bills[obj.id]?.[s.id] : input.values?.[obj.id]?.[s.id]?.[k]),
    reading: (tid, l) => input.readings[tid]?.[lineKey(s.id, l.id)],
    source: (id, tid, unit) => sourceUsage(input, id, tid, unit),
    sourceName: (id) => input.services.find((x) => x.id === id)?.name ?? '?',
  };
}

/** Расчёт одной квитанции из строк на объекте (для рамки на странице объекта). */
export function receiptCalcOf(input: MonthInput, obj: PropertyObject, s: Service): ReceiptCalc | null {
  return s.config ? calcReceipt(s.config, receiptEnv(input, obj, s)) : null;
}

/** Единицы, в которых у квитанции есть счётчики арендаторов (для «суммы других счётчиков»). */
export function meterUnits(s: Service): string[] {
  if (s.config) return [...new Set(s.config.lines.filter((l) => l.q.src === 'each').map((l) => l.unit))];
  return s.tariffs.some((t) => ['meter', 'meterRest', 'split', 'dn'].includes(t.logic)) && s.unit ? [s.unit] : [];
}

/** Расход арендатора по квитанции-источнику в единице unit; undefined — у источника нет такого счётчика. */
export function sourceUsage(input: MonthInput, id: string, tid: string, unit: string): number | null | undefined {
  const src = input.services.find((x) => x.id === id);
  if (!src || !meterUnits(src).includes(unit)) return undefined;
  const rd = input.readings[tid] || {};
  if (src.config) {
    const sl = src.config.lines.find((l) => l.q.src === 'each' && l.unit === unit)!;
    return usageOf(sl.q.read, rd[lineKey(id, sl.id)]);
  }
  // Старая квитанция по счётчику: расход арендатора (день + ночь); нет тарифа у арендатора — 0.
  const tr = activeTariff(src, tid, input.month);
  if (!tr) return 0;
  if (tr.logic === 'dn') {
    const d = readingUsage(rd[id + ':day']).usage, n = readingUsage(rd[id + ':night']).usage;
    return d === null || n === null ? null : d + n;
  }
  return readingUsage(rd[id]).usage;
}

/** Строки счёта, счётчики и пропуски арендатора по квитанции из строк. false — арендатор платит сам. */
function configTenant(ctx: Ctx, s: Service, tenant: Tenant, lines: BillLine[], meters: MeterUse[], missing: string[]): boolean {
  const cfg = s.config!, C = ctx.rc.get(s.id)!;
  if ((cfg.pay.off ?? []).includes(tenant.id)) return false;
  const rd = ctx.input.readings[tenant.id] || {};
  cfg.lines.forEach((l, i) => {
    if (l.q.src !== 'each') return;
    const r = rd[lineKey(s.id, l.id)], lab = lineLabel(cfg, l, i);
    const raw = l.q.read === 'direct' ? (r?.usage ?? null) : r?.cur == null ? null : r.cur - (r.prev ?? 0);
    meters.push({ serviceId: s.id, label: lab ? `${s.name} — ${lab}` : s.name, unit: l.unit, prev: r?.prev, cur: r?.cur,
      usage: usageOf(l.q.read, r), negative: raw !== null && raw < 0 });
  });
  if (!C.ready) {
    missing.push(`${s.name}: ${C.cfg.length ? 'не настроено — ' + C.cfg.join('; ') : 'ждём ' + C.miss.join(', ')}`);
    lines.push({ serviceId: s.id, group: 'common', label: s.name, formula: '—', amount: null });
    return true;
  }
  const k = coefOf(cfg), kk = k !== 1 ? ` × ${fmtQty(k)}` : '';
  for (const x of C.per[tenant.id] ?? []) {
    const L = C.lines.find((y) => y.l.id === x.line);
    const group: LineGroup = x.rest || !L ? 'common' : L.Qi.ind ? 'indiv' : L.l.q.src === 'const' && isRub(L.l) ? 'fixed' : 'common';
    lines.push({ serviceId: s.id, group, label: x.lab ? `${s.name}: ${x.lab}` : s.name, formula: `${x.sign < 0 ? '− ' : ''}${x.how}${kk}`, amount: round2(x.sum * k) });
  }
  return true;
}

/** Расход арендатора по услуге (для день/ночь — сумма зон). */
function tenantUsage(ctx: Ctx, tenantId: string, service: Service, tariff: Tariff): number | null {
  const rd = ctx.input.readings[tenantId] || {};
  if (tariff.logic === 'dn') {
    const d = readingUsage(rd[service.id + ':day']).usage;
    const n = readingUsage(rd[service.id + ':night']).usage;
    return d === null || n === null ? null : d + n;
  }
  return readingUsage(rd[service.id]).usage;
}

/** Арендаторы объекта, у которых по услуге действует тариф с той же логикой (делят один счёт). */
function mates(ctx: Ctx, service: Service, logic: Tariff['logic']): Array<[Tenant, Tariff]> {
  const out: Array<[Tenant, Tariff]> = [];
  for (const t of ctx.obj.tenants) {
    const tr = activeTariff(service, t.id, ctx.input.month);
    if (tr && tr.logic === logic) out.push([t, tr]);
  }
  return out;
}

/** Начисление по «счётчики + остаток» до округления: свой расход × цена (+ расход × норматив × цена норматива). */
function meterRestPart(usage: number | null, tr: Tariff): number | null {
  if (usage === null || tr.price === undefined) return null;
  const extra = tr.norm !== undefined && tr.normPrice !== undefined ? usage * tr.norm * tr.normPrice : 0;
  return usage * tr.price + extra;
}

/** Доля «поровну» в копейках: остаток копеек отдаём первым по порядку, чтобы сумма сошлась с квитанцией. */
function equalPart(bill: number, n: number, i: number): number {
  const cents = Math.round(bill * 100);
  const base = Math.floor(cents / n);
  return (base + (i < cents - base * n ? 1 : 0)) / 100;
}

function calcTenant(ctx: Ctx, tenant: Tenant): TenantBill {
  const { input, obj } = ctx;
  const lines: BillLine[] = [];
  const meters: MeterUse[] = [];
  const missing: string[] = [];
  const rd = input.readings[tenant.id] || {};
  const bills = input.bills[obj.id] || {};

  const pairs: Array<[Service, Tariff]> = [];
  for (const s of input.services) {
    if (s.config || s.kind === 'owner' || !onObject(s, obj)) continue;
    const tr = activeTariff(s, tenant.id, input.month);
    if (tr) pairs.push([s, tr]);
  }
  const tariffOf = new Map(pairs.map(([s, tr]) => [s.id, tr]));
  let configCount = 0;

  // 1. Счётчики: расход каждой услуги (нужен и для производных услуг).
  const use: Record<string, number | null> = {};
  const addMeter = (s: Service, key: string, label: string) => {
    const r = rd[key];
    const { usage, negative } = readingUsage(r);
    meters.push({ serviceId: s.id, label, unit: s.unit, prev: r?.prev, cur: r?.cur, usage, negative });
    if (usage === null) missing.push(`Показание: ${label}`);
    return usage;
  };
  for (const [s, tr] of pairs) {
    if (tr.logic === 'meter' || tr.logic === 'meterRest' || tr.logic === 'split') use[s.id] = addMeter(s, s.id, s.name);
    if (tr.logic === 'dn') {
      const d = addMeter(s, s.id + ':day', s.name + ' — день');
      const n = addMeter(s, s.id + ':night', s.name + ' — ночь');
      use[s.id + ':day'] = d;
      use[s.id + ':night'] = n;
      use[s.id] = d === null || n === null ? null : d + n;
    }
  }

  const line = (s: Service, tr: Tariff, label: string, formula: string, raw: number | null, note?: string, group?: LineGroup) => {
    const g: LineGroup = group ?? (tr.logic === 'fixed' ? 'fixed' : s.kind === 'common' ? 'common' : 'indiv');
    lines.push({ serviceId: s.id, group: g, label, formula, note, amount: raw === null ? null : round2(raw) });
  };
  const q = (u: number | null) => (u === null ? '—' : fmtQty(u));

  // 2. Строки счёта в порядке услуг.
  for (const s of input.services) {
    if (s.config) {
      if (ctx.rc.has(s.id) && configTenant(ctx, s, tenant, lines, meters, missing)) configCount++;
      continue;
    }
    const tr = tariffOf.get(s.id);
    if (!tr) continue;
    const p = tr.price ?? null;
    switch (tr.logic) {
      case 'meter': {
        const u = use[s.id];
        line(s, tr, s.name, `${q(u)} ${s.unit} × ${fmtPrice(p ?? 0)} руб.`, u === null || p === null ? null : u * p);
        break;
      }
      case 'dn': {
        const d = use[s.id + ':day'], n = use[s.id + ':night'], p2 = tr.price2 ?? null;
        line(s, tr, s.name, `${q(d)} × ${fmtPrice(p ?? 0)} + ${q(n)} × ${fmtPrice(p2 ?? 0)} руб.`,
          d === null || n === null || p === null || p2 === null ? null : d * p + n * p2);
        break;
      }
      case 'derived':
      case 'norm': {
        const src = (tr.sources || []).filter((id) => id in use);
        const u = src.length && src.every((id) => use[id] !== null) ? src.reduce((a, id) => a + (use[id] as number), 0) : null;
        if (!src.length) missing.push(`${s.name}: нет услуг-источников расхода`);
        if (tr.logic === 'derived') line(s, tr, s.name, `${q(u)} м³ × ${fmtPrice(p ?? 0)} руб.`, u === null || p === null ? null : u * p);
        else {
          const nm = tr.norm ?? null;
          line(s, tr, s.name, `${q(u)} м³ × ${fmtQty(nm ?? 0)} × ${fmtPrice(p ?? 0)} руб.`, u === null || p === null || nm === null ? null : u * nm * p);
        }
        break;
      }
      case 'share': {
        const bill = bills[s.id];
        if (bill === undefined) missing.push(`Сумма по квитанции: ${s.supplier} — ${s.name}`);
        line(s, tr, s.name, `${bill === undefined ? '—' : fmtMoney(bill)} руб. × ${pct(tenant.share)}`,
          bill === undefined ? null : (bill * tenant.share) / 100, undefined, 'common');
        break;
      }
      case 'split': {
        const bill = bills[s.id];
        if (bill === undefined) missing.push(`Сумма счёта на объект: ${s.supplier} — ${s.name}`);
        const all = mates(ctx, s, 'split').map(([t, mt]) => tenantUsage(ctx, t.id, s, mt));
        const denom = all.every((v) => v !== null) ? all.reduce((a, v) => a + (v as number), 0) : null;
        const price = bill !== undefined && denom ? bill / denom : null;
        const u = use[s.id];
        line(s, tr, s.name, `${q(u)} ${s.unit} × ${price === null ? '—' : fmtPrice(price)} руб.`,
          u === null || price === null ? null : u * price,
          `цена месяца = ${bill === undefined ? '—' : fmtMoney(bill)} ₽ ÷ ${denom === null ? '—' : fmtQty(denom)} ${s.unit} (всего у арендаторов)`, 'common');
        break;
      }
      case 'meterRest': {
        const bill = bills[s.id];
        if (bill === undefined) missing.push(`Сумма счёта на объект: ${s.supplier} — ${s.name}`);
        const u = use[s.id];
        const hasNorm = tr.norm !== undefined && tr.normPrice !== undefined;
        line(s, tr, s.name, `${q(u)} ${s.unit} × ${fmtPrice(p ?? 0)} руб.`, u === null || p === null ? null : u * p, undefined, 'common');
        const xn = (tr.extraName || '').trim();
        if (hasNorm) {
          line(s, tr, `${xn || 'Доп. начисление'} — норматив`, `${q(u)} ${s.unit} × ${fmtQty(tr.norm!)} × ${fmtPrice(tr.normPrice!)} руб.`,
            u === null ? null : u * tr.norm! * tr.normPrice!, undefined, 'common');
        }
        const parts = mates(ctx, s, 'meterRest').map(([t, mt]) => meterRestPart(tenantUsage(ctx, t.id, s, mt), mt));
        const indivSum = parts.every((v) => v !== null) ? parts.reduce((a, v) => a + (v as number), 0) : null;
        const rest = bill !== undefined && indivSum !== null ? round2(bill - indivSum) : null;
        line(s, tr, xn ? `${xn} — остаток` : 'Остаток по долям', `${rest === null ? '—' : fmtMoney(rest)} руб. × ${pct(tenant.share)}`,
          rest === null ? null : (rest * tenant.share) / 100,
          rest === null ? undefined : `остаток = ${fmtMoney(bill!)} ₽ по счёту − ${fmtMoney(indivSum!)} ₽ по счётчикам арендаторов`, 'common');
        break;
      }
      case 'equal': {
        const bill = bills[s.id];
        if (bill === undefined) missing.push(`Сумма по квитанции: ${s.supplier} — ${s.name}`);
        const m = mates(ctx, s, 'equal');
        const i = m.findIndex(([t]) => t.id === tenant.id);
        line(s, tr, s.name, `${bill === undefined ? '—' : fmtMoney(bill)} руб. ÷ ${m.length}`,
          bill === undefined ? null : equalPart(bill, m.length, i), undefined, 'common');
        break;
      }
      case 'fixed':
        if (p === null) missing.push(`${s.name}: не указана сумма`);
        line(s, tr, s.name, 'фиксированная сумма', p, undefined, 'fixed');
        break;
      case 'whole':
        break;
    }
  }

  const total = sumMoney(lines.filter((l) => l.amount !== null).map((l) => l.amount as number));
  return { tenantId: tenant.id, objectId: obj.id, lines, meters, total, missing, serviceCount: pairs.length + configCount };
}

/** Что остаётся на арендодателе: незанятая доля по «доле», незанятая доля остатка, услуги «только арендодатель». */
function calcOwner(ctx: Ctx): { lines: OwnerLine[]; total: number } {
  const { input, obj } = ctx;
  const bills = input.bills[obj.id] || {};
  const lines: OwnerLine[] = [];
  for (const s of input.services) {
    if (!onObject(s, obj)) continue;
    if (s.config) {
      const C = ctx.rc.get(s.id);
      if (!C) continue;
      const nobody = obj.tenants.every((t) => (s.config!.pay.off ?? []).includes(t.id));
      if (C.ready ? C.mine !== 0 : nobody) lines.push({ serviceId: s.id, label: `${s.name} — на вас`, amount: C.ready ? C.mine : null });
      continue;
    }
    const bill = bills[s.id];
    if (s.kind === 'owner') {
      if (bill !== undefined) lines.push({ serviceId: s.id, label: s.name, amount: round2(bill) });
      continue;
    }
    for (const logic of ['share', 'meterRest'] as const) {
      const m = mates(ctx, s, logic);
      if (!m.length || bill === undefined) continue;
      const covered = m.reduce((a, [t]) => a + t.share, 0);
      const free = Math.max(0, 100 - covered);
      if (!free) continue;
      let base: number | null = bill;
      if (logic === 'meterRest') {
        const parts = m.map(([t, mt]) => meterRestPart(tenantUsage(ctx, t.id, s, mt), mt));
        base = parts.every((v) => v !== null) ? round2(bill - parts.reduce((a, v) => a + (v as number), 0)) : null;
      }
      lines.push({ serviceId: s.id, label: `${s.name} — незанятая доля ${pct(free)}`, amount: base === null ? null : round2((base * free) / 100) });
    }
  }
  return { lines, total: sumMoney(lines.filter((l) => l.amount !== null).map((l) => l.amount as number)) };
}

/** Расчёт месяца по всем объектам. */
export function calculateMonth(input: MonthInput): MonthResult {
  const result: MonthResult = { tenants: {}, owner: {} };
  for (const obj of input.objects) {
    const rc = new Map<string, ReceiptCalc>();
    for (const s of input.services) if (s.config && onObject(s, obj)) rc.set(s.id, calcReceipt(s.config, receiptEnv(input, obj, s)));
    const ctx: Ctx = { input, obj, rc };
    for (const t of obj.tenants) result.tenants[t.id] = calcTenant(ctx, t);
    result.owner[obj.id] = calcOwner(ctx);
  }
  return result;
}
